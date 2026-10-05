import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Policy } from "../index.ts";
import type { CommandResult } from "./commands/context.ts";
import type { SqlConnect } from "./pg.ts";
import type { PermDockConfig } from "./types.ts";

import { createPermDock, findPermission, memoryRoleSource } from "../index.ts";
import { usageResult } from "./errors.ts";
import {
  type RlsFixture,
  fixtureRow,
  fixtureSubject,
  loadFixtures,
} from "./fixtures.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";
import { connectPg } from "./pg.ts";
import {
  POSTGRES,
  type PowerSyncStream,
  powersyncPlan,
  powersyncYaml,
} from "./powersync-streams.ts";
import { quoteIdent } from "./rls-sql.ts";
import { canFixture } from "./rls-verify.ts";

export const POWERSYNC_HELP = `permdock powersync generate [--out sync-config.yaml] [--check]
permdock powersync verify [--db <url>] [--fixtures rls.fixtures.json]`;

const DEFAULT_OUT = "sync-config.yaml";

export function powersyncOut(config: PermDockConfig, out?: string): string {
  return out ?? config.powersync?.out ?? DEFAULT_OUT;
}

async function loadPolicy(
  cwd: string,
  config: PermDockConfig,
  from: string | undefined,
): Promise<Policy> {
  const path = from ?? config.policy;
  if (path === undefined) {
    throw new Error(
      "PermDock CLI: powersync needs policy in the config or --from",
    );
  }
  return asPolicy(pickNamed(await loadModule(resolve(cwd, path)), ["policy"]));
}

/** The Sync Streams file the policy compiles to, with the grants that do not sync. */
export function powersyncFile(
  policy: Policy,
  config: PermDockConfig,
): { readonly yaml: string; readonly warnings: readonly string[] } {
  const plan = powersyncPlan(policy, config);
  return { yaml: powersyncYaml(plan), warnings: plan.warnings };
}

function rowValue(row: unknown, key: string | undefined): string | undefined {
  const value =
    key !== undefined &&
    row !== null &&
    typeof row === "object" &&
    !Array.isArray(row)
      ? Object.entries(row).find(([name]) => name === key)?.[1]
      : undefined;
  return value === undefined || value === null ? undefined : String(value);
}

/** Whether the stream holds the fixture's row for its subject. */
async function synced(
  query: (sql: string, values: unknown[]) => Promise<readonly unknown[]>,
  stream: PowerSyncStream,
  fixture: RlsFixture,
): Promise<boolean> {
  const value = rowValue(fixture.row, stream.id);
  if (value === undefined) {
    return false;
  }
  for (const text of stream.queries) {
    // Every parameter is typed in the outer query, so a stream query that uses none still prepares.
    const rows = await query(
      `select 1 from (${text}) q where q.${quoteIdent(stream.id)}::text = $3::text and $1::text is not null and $2::jsonb is not null limit 1`,
      [fixture.subject.id, "{}", value],
    );
    if (rows.length > 0) {
      return true;
    }
  }
  return false;
}

async function verifyStreams(input: {
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly fixtures: readonly RlsFixture[];
  readonly customRoles: Parameters<typeof memoryRoleSource>[0];
  readonly db: string;
  readonly connect: SqlConnect;
}): Promise<{ readonly mismatches: string[]; readonly notes: string[] }> {
  const plan = powersyncPlan(input.policy, input.config, POSTGRES);
  const mismatches: string[] = [];
  const notes: string[] = [];
  const client = await input.connect(input.db);
  const query = async (sql: string, values: unknown[]) =>
    (await client.query(sql, values)).rows;
  const root = input.policy.scopes.find(
    (scope) => scope.within === undefined,
  )?.key;
  try {
    for (const fixture of input.fixtures) {
      const permission = findPermission(
        input.policy.permissions,
        fixture.action,
      );
      const stream = plan.streams.find(
        (item) =>
          permission !== undefined &&
          item.resource === permission.resource &&
          permission.action === (input.config.powersync?.action ?? "read"),
      );
      if (permission === undefined || stream === undefined) {
        continue;
      }
      // A stream holds rows of every organization the user belongs to, so the
      // policy is asked with the row's own organization active.
      const tenant = rowValue(fixture.row, root);
      const permdock = await createPermDock(
        input.policy,
        fixtureSubject({
          ...fixture.subject,
          ...(tenant === undefined ? {} : { tenant }),
        }),
        { customRoles: memoryRoleSource(input.customRoles) },
      );
      const granted = canFixture(
        permdock,
        permission,
        fixtureRow(fixture, permission.kind),
      );
      const holds = await synced(query, stream, fixture);
      if (holds && !granted) {
        mismatches.push(
          `${fixture.action} for ${fixture.subject.id}: stream ${stream.name} syncs a row the policy denies`,
        );
      } else if (granted && !holds) {
        notes.push(
          `${fixture.action} for ${fixture.subject.id}: granted, not synced (the app reads it from the server)`,
        );
      }
    }
  } finally {
    await client.end();
  }
  return { mismatches, notes };
}

export async function runPowerSync(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly out?: string;
  readonly check: boolean;
  readonly db?: string;
  readonly fixtures?: string;
  readonly from?: string;
  /** Opens the `--db` connection; defaults to the `pg` peer. */
  readonly connect?: SqlConnect;
}): Promise<CommandResult> {
  const [verb] = input.rest;
  if (verb !== "generate" && verb !== "verify") {
    return { code: 2, output: POWERSYNC_HELP };
  }
  let policy: Policy;
  let file: ReturnType<typeof powersyncFile>;
  try {
    policy = await loadPolicy(input.cwd, input.config, input.from);
    file = powersyncFile(policy, input.config);
  } catch (cause) {
    return usageResult(cause);
  }
  const { yaml, warnings } = file;
  const out = powersyncOut(input.config, input.out);
  const path = resolve(input.cwd, out);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (verb === "generate") {
    if (input.check) {
      return current === yaml
        ? { code: 0, output: `${out} is current` }
        : {
            code: 1,
            output: `${out} is stale: run permdock powersync generate`,
          };
    }
    writeFileSync(path, yaml);
    return { code: 0, output: [`wrote ${out}`, ...warnings].join("\n") };
  }
  const mismatches: string[] = [];
  const notes: string[] = [...warnings];
  if (current !== yaml) {
    mismatches.push(
      `${out} ${current === undefined ? "is missing" : "differs from the policy"}: run permdock powersync generate`,
    );
  }
  if (input.db !== undefined) {
    try {
      const fixturesPath =
        input.fixtures ?? input.config.rls?.fixtures ?? "rls.fixtures.json";
      const { fixtures, customRoles } = await loadFixtures(
        input.cwd,
        fixturesPath,
      );
      const database = await verifyStreams({
        policy,
        config: input.config,
        fixtures,
        customRoles,
        db: input.db,
        connect:
          input.connect ??
          ((db: string) => connectPg(db, "permdock powersync verify --db")),
      });
      mismatches.push(...database.mismatches);
      notes.push(...database.notes);
    } catch (cause) {
      return usageResult(cause);
    }
  }
  if (mismatches.length > 0) {
    return { code: 1, output: [...mismatches, ...notes].join("\n") };
  }
  const verified =
    input.db === undefined
      ? `${out} matches the policy`
      : `${out} matches the policy; no stream syncs a row the fixtures deny`;
  return {
    code: 0,
    output: notes.length === 0 ? verified : `${verified}\n${notes.join("\n")}`,
  };
}
