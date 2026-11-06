import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";

import { ROWS, setupSql, TENANTS } from "../fixtures/row-hot-path/policy.ts";
import { defined } from "../src/support/defined.ts";
import { startPostgres } from "../src/support/postgres.ts";
import { rlsGenerate, jwtClaims } from "../src/support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/row-hot-path");

const RUNS = 7;
const READER = "00000000-0000-4000-8000-000000000000";
const EDITOR = "00000000-0000-4000-8000-000000000001";
const KNOWN = "00000000-0000-4000-8002-000000000000";
const KNOWN_EDIT = "00000000-0000-4000-8002-000000000001";

type Measured = {
  readonly shape: string;
  readonly rows: number;
  readonly medianMs: number;
  readonly sharedHit: number;
  readonly sharedRead: number;
  readonly calls: Readonly<Record<string, number>>;
};

type Explain = {
  readonly Plan: {
    readonly "Shared Hit Blocks"?: number;
    readonly "Shared Read Blocks"?: number;
  };
  readonly "Execution Time": number;
};

const SHAPES: readonly {
  readonly shape: string;
  readonly user: string;
  readonly sql: string;
}[] = [
  {
    shape: "id in (select rows('item.read')) [root-scope role]",
    user: READER,
    sql: `select count(*) from public.item where id in (select permdock.permitted_item_rows('item.read'))`,
  },
  {
    shape: "id::text in (select rows::text) [legacy]",
    user: READER,
    sql: `select count(*) from public.item where id::text in (select permdock.permitted_item_rows('item.read')::text)`,
  },
  {
    shape: "id in (select rows('item.edit')) [conditioned grant]",
    user: EDITOR,
    sql: `select count(*) from public.item where id in (select permdock.permitted_item_rows('item.edit'))`,
  },
  {
    shape: "permitted_item_row(id, 'item.read') [one known id]",
    user: READER,
    sql: `select permdock.permitted_item_row(id, 'item.read') from public.item where id = '${KNOWN}'`,
  },
  {
    shape: "permitted_item_row(id, 'item.edit') [one known id, conditioned]",
    user: EDITOR,
    sql: `select permdock.permitted_item_row(id, 'item.edit') from public.item where id = '${KNOWN_EDIT}'`,
  },
  {
    shape: "hand-written fn over rows() for one known id",
    user: READER,
    sql: `select public.may_read_item('${KNOWN}')`,
  },
  {
    shape: "id = any(array(select rows('item.read'))) for one known id",
    user: READER,
    sql: `select count(*) from public.item where id = '${KNOWN}' and id = any(array(select permdock.permitted_item_rows('item.read')))`,
  },
];

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

describe("row helpers on the hot path", () => {
  let db: Postgres | undefined;
  const measured: Measured[] = [];

  async function once(
    user: string,
    sql: string,
  ): Promise<{
    readonly plan: Explain;
    readonly calls: Record<string, number>;
    readonly rows: number;
  }> {
    const target = defined(db);
    return target.as(
      { role: "authenticated", settings: jwtClaims(user) },
      async () => {
        const count = async (): Promise<Record<string, number>> => {
          const counted = await target.tester.query<{
            funcname: string;
            calls: string;
          }>(
            "select funcname, calls::text from pg_stat_xact_user_functions where schemaname = 'permdock'",
          );
          return Object.fromEntries(
            counted.rows.map((row) => [row.funcname, Number(row.calls)]),
          );
        };
        const before = await count();
        const answer = await target.tester.query<Record<string, unknown>>(sql);
        const after = await count();
        const calls = Object.fromEntries(
          Object.entries(after).map(([name, value]) => [
            name,
            value - (before[name] ?? 0),
          ]),
        );
        const first = Object.values(answer.rows[0] ?? {})[0];
        const result = await target.tester.query<{ "QUERY PLAN": Explain[] }>(
          `explain (analyze, buffers, format json) ${sql}`,
        );
        const plan = result.rows[0]?.["QUERY PLAN"][0];
        return {
          plan: defined(plan),
          calls,
          rows:
            typeof first === "string" ? Number(first) : first === true ? 1 : 0,
        };
      },
    );
  }

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-hot-path-"));
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    const sql = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([
      setupSql,
      sql,
      `create function public.may_read_item(p_id uuid) returns boolean
         language sql stable as $$
           select p_id in (select permdock.permitted_item_rows('item.read'))
         $$;
       grant execute on function public.may_read_item(uuid) to authenticated`,
      "grant set on parameter track_functions to tester",
      "analyze",
    ]);
    await defined(db).tester.query("set track_functions = 'all'");
    for (const { shape, user, sql: statement } of SHAPES) {
      const times: number[] = [];
      let first: Awaited<ReturnType<typeof once>> | undefined;
      for (let index = 0; index < RUNS; index += 1) {
        const result = await once(user, statement);
        first ??= result;
        times.push(result.plan["Execution Time"]);
      }
      const head = defined(first);
      measured.push({
        shape,
        rows: head.rows,
        medianMs: median(times),
        sharedHit: head.plan.Plan["Shared Hit Blocks"] ?? 0,
        sharedRead: head.plan.Plan["Shared Read Blocks"] ?? 0,
        calls: head.calls,
      });
    }
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("reports the hot-path numbers", async ({ annotate }) => {
    for (const row of measured) {
      const byPermission = Object.entries(row.calls)
        .filter(([name]) => name.includes("by_permission"))
        .map(([name, calls]) => `${name}=${String(calls)}`)
        .join(",");
      await annotate(
        `row-hot-path: ${String(ROWS)} rows, ${String(TENANTS)} tenants, median of ${String(RUNS)}: ${row.shape}: ${row.medianMs.toFixed(2)} ms, shared hit ${String(row.sharedHit)}, read ${String(row.sharedRead)}, ${byPermission === "" ? "no by-permission call" : byPermission}`,
      );
    }
    expect(measured).toHaveLength(SHAPES.length);
  });

  it("answers alike through the native and the legacy text shape", () => {
    const native = measured.find((row) => row.shape.startsWith("id in"));
    const legacy = measured.find((row) => row.shape.includes("[legacy]"));
    expect(defined(native).rows).toBe(ROWS / TENANTS);
    expect(defined(legacy).rows).toBe(ROWS / TENANTS);
  });

  it("reads the by-permission helper at most once per statement", () => {
    for (const row of measured) {
      const calls = Object.entries(row.calls)
        .filter(([name]) => name.includes("by_permission"))
        .reduce((total, [, value]) => total + value, 0);
      expect(calls).toBeLessThanOrEqual(1);
    }
  });

  it("checks one known id faster with permitted_item_row than with the full rows() form", () => {
    const scalar = measured.find((row) =>
      row.shape.startsWith("permitted_item_row(id, 'item.read')"),
    );
    const full = measured.find((row) =>
      row.shape.startsWith("hand-written fn"),
    );
    expect(defined(scalar).medianMs * 2).toBeLessThan(defined(full).medianMs);
    expect(defined(scalar).sharedHit).toBeLessThan(defined(full).sharedHit);
  });
});
