import { resolve } from "node:path";

import type { Policy } from "../../index.ts";
import type { CommandResult } from "../core/result.ts";
import type { RlsFixture } from "../fixtures.ts";
import type { SqlConnect } from "../pg.ts";
import type { PermDockConfig } from "../types.ts";
import type {
  PowerSyncPlan,
  PowerSyncStream,
  SubjectStream,
} from "./streams.ts";

import {
  findPermission,
  getPermDock,
  localSnapshotManifest,
  memoryCustomRoleSource,
} from "../../index.ts";
import { usageResult } from "../core/errors.ts";
import { applyFiles } from "../core/files.ts";
import { fileDrift } from "../core/output-files.ts";
import { fixtureRow, fixtureSubject, loadFixtures } from "../fixtures.ts";
import { pgConnector } from "../pg.ts";
import { requirePolicy } from "../project/load.ts";
import { canFixture } from "../rls/verify.ts";
import { quoteIdent } from "../sql/quote.ts";
import { localRows } from "./rows.ts";
import { POSTGRES, powersyncPlan, powersyncYaml } from "./streams.ts";
import { warnedFor } from "./verify-gaps.ts";

const POWERSYNC_HELP = `permdock powersync generate [--out sync-config.yaml] [--check]
permdock powersync verify [--db-url-stdin] [--fixtures rls.fixtures.json]`;

const DEFAULT_OUT = "sync-config.yaml";

function powersyncOut(config: PermDockConfig, out?: string): string {
  return out ?? config.powersync?.out ?? DEFAULT_OUT;
}

function loadPolicy(
  cwd: string,
  config: PermDockConfig,
  from: string | undefined,
): Promise<Policy> {
  return requirePolicy(
    cwd,
    from ?? config.policy,
    "powersync needs policy in the config or --policy",
  );
}

export type PowerSyncFile = {
  readonly path: string;
  readonly text: string;
  /** Compared as parsed JSON, so a formatter run over the file keeps it current. */
  readonly json?: true;
};

function sameJson(current: string, expected: string): boolean {
  try {
    return (
      JSON.stringify(JSON.parse(current)) ===
      JSON.stringify(JSON.parse(expected))
    );
  } catch {
    return false;
  }
}

/**
 * The files the policy compiles to: the Sync Streams file and, with
 * `powersync.manifest`, the local-snapshot manifest. `warnings` lists the
 * grants that do not sync.
 */
export function powersyncFiles(
  policy: Policy,
  config: PermDockConfig,
  out?: string,
): {
  readonly files: readonly PowerSyncFile[];
  readonly warnings: readonly string[];
  readonly publication?: string;
} {
  const plan = powersyncPlan(policy, config);
  const files: PowerSyncFile[] = [
    { path: powersyncOut(config, out), text: powersyncYaml(plan) },
  ];
  const manifest = config.powersync?.manifest;
  if (manifest !== undefined) {
    files.push({
      path: manifest,
      json: true,
      text: `${JSON.stringify(
        {
          ...localSnapshotManifest(policy),
          rows: localRows(policy, config, plan.devices),
        },
        null,
        2,
      )}\n`,
    });
  }
  return {
    files,
    warnings: plan.warnings,
    ...(plan.publication === undefined
      ? {}
      : { publication: plan.publication }),
  };
}

/**
 * The files whose content on disk is not what the policy compiles to, with
 * `missing` for an absent one.
 */
export function staleFiles(
  cwd: string,
  files: readonly PowerSyncFile[],
): readonly { readonly path: string; readonly missing: boolean }[] {
  const stale: { path: string; missing: boolean }[] = [];
  for (const file of files) {
    const found = fileDrift(
      resolve(cwd, file.path),
      file.text,
      file.json === true ? sameJson : undefined,
    );
    if (found !== undefined) {
      stale.push({ path: file.path, missing: found.kind === "missing" });
    }
  }
  return stale;
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

function claimsJson(fixture: RlsFixture): string {
  return JSON.stringify(fixture.subject.claims ?? {});
}

/** Whether a stream of the user's own rows holds a row of another user. */
async function leaks(
  query: (sql: string, values: unknown[]) => Promise<readonly unknown[]>,
  stream: SubjectStream,
  user: string,
  fixture: RlsFixture,
): Promise<boolean> {
  for (const text of stream.queries) {
    const rows = await query(
      `select 1 from (${text}) q where q.${quoteIdent(user)}::text is distinct from $1::text and $2::jsonb is not null limit 1`,
      [fixture.subject.id, claimsJson(fixture)],
    );
    if (rows.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the stream holds the fixture's row for its subject; `undefined` for a
 * row with no id.
 */
async function synced(
  query: (sql: string, values: unknown[]) => Promise<readonly unknown[]>,
  stream: PowerSyncStream,
  fixture: RlsFixture,
): Promise<boolean | undefined> {
  const value = rowValue(fixture.row, stream.id);
  if (value === undefined) {
    return undefined;
  }
  for (const text of stream.queries) {
    // Every parameter is typed in the outer query, so a stream query that uses none still prepares.
    const rows = await query(
      `select 1 from (${text}) q where q.${quoteIdent(stream.id)}::text = $3::text and $1::text is not null and $2::jsonb is not null limit 1`,
      [fixture.subject.id, claimsJson(fixture), value],
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
  readonly customRoles: Parameters<typeof memoryCustomRoleSource>[0];
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
    const checked = new Set<string>();
    for (const fixture of input.fixtures) {
      if (checked.has(fixture.subject.id)) {
        continue;
      }
      checked.add(fixture.subject.id);
      for (const stream of plan.subject) {
        if (
          stream.user !== undefined &&
          (await leaks(query, stream, stream.user, fixture))
        ) {
          mismatches.push(
            `stream ${stream.name} syncs another user's ${stream.table} rows to ${fixture.subject.id}`,
          );
        }
      }
    }
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
      const permdock = await getPermDock(
        input.policy,
        fixtureSubject({
          ...fixture.subject,
          ...(tenant === undefined ? {} : { tenant }),
        }),
        { customRoles: memoryCustomRoleSource(input.customRoles) },
      );
      const granted = canFixture(
        permdock,
        permission,
        fixtureRow(fixture, permission.kind),
      );
      const holds = await synced(query, stream, fixture);
      if (holds === undefined) {
        notes.push(
          `${fixture.action} for ${fixture.subject.id}: not checked against stream ${stream.name}: the fixture row has no ${stream.id}`,
        );
      } else if (holds && !granted) {
        mismatches.push(
          `${fixture.action} for ${fixture.subject.id}: stream ${stream.name} syncs a row the policy denies`,
        );
      } else if (
        granted &&
        !holds &&
        warnedFor(
          plan.unsynced,
          permission.key,
          fixture.subject,
          input.customRoles,
        )
      ) {
        notes.push(
          `${fixture.action} for ${fixture.subject.id}: granted, not synced (the app reads it from the server)`,
        );
      } else if (granted && !holds) {
        mismatches.push(
          `${fixture.action} for ${fixture.subject.id}: granted, but stream ${stream.name} does not sync the row and generate gave no warning for it`,
        );
      }
    }
    await checkPublication(query, plan, mismatches, notes);
  } finally {
    await client.end();
  }
  return { mismatches, notes };
}

/**
 * PD058 when the `powersync` publication leaves out a synced table outside
 * `public`; a note when the database has no such publication.
 */
async function checkPublication(
  query: (sql: string, values: unknown[]) => Promise<readonly unknown[]>,
  plan: PowerSyncPlan,
  mismatches: string[],
  notes: string[],
): Promise<void> {
  if (plan.outside.length === 0) {
    return;
  }
  const publication = await query(
    "select 1 from pg_catalog.pg_publication where pubname = 'powersync'",
    [],
  );
  if (publication.length === 0) {
    notes.push(
      `this database has no powersync publication; PowerSync needs the synced tables in it: ${plan.publication ?? ""}`,
    );
    return;
  }
  const published = new Set(
    (
      await query(
        "select schemaname || '.' || tablename as name from pg_catalog.pg_publication_tables where pubname = 'powersync'",
        [],
      )
    ).flatMap((row) => {
      const name = rowValue(row, "name");
      return name === undefined ? [] : [name];
    }),
  );
  for (const table of plan.outside) {
    if (!published.has(table)) {
      mismatches.push(
        `PD058: ${table} is not in the powersync publication, so PowerSync syncs none of its rows: ${plan.publication ?? ""}`,
      );
    }
  }
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
  /** Opens the `--db-url-stdin` connection; defaults to the `pg` peer. */
  readonly connect?: SqlConnect;
}): Promise<CommandResult> {
  const [verb] = input.rest;
  if (verb !== "generate" && verb !== "verify") {
    return { code: 2, output: POWERSYNC_HELP };
  }
  let policy: Policy;
  let compiled: ReturnType<typeof powersyncFiles>;
  try {
    policy = await loadPolicy(input.cwd, input.config, input.from);
    compiled = powersyncFiles(policy, input.config, input.out);
  } catch (cause) {
    return usageResult(cause);
  }
  const { files, warnings } = compiled;
  const out = powersyncOut(input.config, input.out);
  const stale = staleFiles(input.cwd, files);
  if (verb === "generate") {
    if (input.check) {
      return stale.length === 0
        ? {
            code: 0,
            output: files.map((file) => `${file.path} is current`).join("\n"),
          }
        : {
            code: 1,
            output: stale
              .map(
                (file) =>
                  `${file.path} is stale: run permdock powersync generate`,
              )
              .join("\n"),
          };
    }
    applyFiles(input.cwd, files);
    return {
      code: 0,
      output: [
        ...files.map((file) => `wrote ${file.path}`),
        ...(compiled.publication === undefined
          ? []
          : [
              `add the tables outside public to the powersync publication: ${compiled.publication}`,
            ]),
        ...warnings,
      ].join("\n"),
    };
  }
  const mismatches: string[] = stale.map(
    (file) =>
      `${file.path} ${file.missing ? "is missing" : "differs from the policy"}: run permdock powersync generate`,
  );
  const notes: string[] = [...warnings];
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
          pgConnector("permdock powersync verify --db-url-stdin", input.cwd),
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
