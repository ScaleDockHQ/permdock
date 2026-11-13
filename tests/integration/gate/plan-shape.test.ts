import type { PoolClient } from "pg";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";

import {
  CALLER_TENANTS,
  SCALE_CALLER,
  SCALE_TABLES,
  scaleSeed,
} from "../bench/fixtures/scale/scale-seed.ts";
import { KIND, uuidOf } from "../bench/fixtures/scale/tiers.ts";
import { AUTH, ROLES } from "../src/support/declarative-fixtures.ts";
import { startPostgres } from "../src/support/postgres.ts";
import { rlsGenerate } from "../src/support/rls.ts";

/**
 * The `rls-bench` gate: the plan shapes of the generated policies on the 1k
 * tier of the scale fixture (`bench/fixtures/scale`). Run it with `pnpm
 * rls-bench`; Docker must be running. A shape that regresses to a scan, a
 * helper that runs more than once per statement, or a statement over its
 * ceiling fails it. The 1k-tier medians in `bench/baselines/scale-1k.json` are
 * under 1 ms, so the ceilings catch a complexity change and not runner noise.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SCALE_PROJECT = join(HERE, "../bench/fixtures/scale/project");
const HELPER_PREFIXES = ["permitted_", "member_", "permdock_"] as const;
/** Warm median of one statement, in ms. */
const TIME_CEILING_MS = 50;
/** The fixed cost of the helpers in a statement that returns no rows, warm. */
const HELPER_WARM_CEILING_MS = 25;
/** The same statement as the first one of a new backend. */
const HELPER_COLD_CEILING_MS = 250;
const WARM_RUNS = 5;

type PlanNode = {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Function Name"?: string;
  readonly "Actual Loops": number;
  readonly Output?: readonly string[];
  readonly Plans?: readonly PlanNode[];
};
type Explained = readonly [
  { readonly Plan: PlanNode; readonly "Execution Time": number },
];

function nodes(plan: PlanNode): readonly PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

function callsHelper(node: PlanNode): boolean {
  const text = [node["Function Name"] ?? "", ...(node.Output ?? [])].join(" ");
  return HELPER_PREFIXES.some((prefix) => text.includes(`permdock.${prefix}`));
}

async function explain(
  client: PoolClient,
  sql: string,
): Promise<Explained[number]> {
  const result = await client.query<{ "QUERY PLAN": Explained }>(
    `explain (analyze, verbose, format json) ${sql}`,
  );
  const plan = result.rows[0]?.["QUERY PLAN"][0];
  if (plan === undefined) {
    throw new Error("PermDock: explain returned no plan");
  }
  return plan;
}

/** Prints `PLAN_MS <name> <ms>` so a before and after run can be compared. */
function reportMs(name: string, ms: number): void {
  process.stderr.write(`PLAN_MS ${name} ${ms.toFixed(3)}\n`);
}

function median(values: readonly number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

describe("rls-bench plan shapes, 1k tier", () => {
  let db: Postgres | undefined;
  let scale: Pool | undefined;

  const pool = (): Pool => {
    if (scale === undefined) {
      throw new Error("PermDock: the scale database is not open");
    }
    return scale;
  };

  /** A transaction as the fixture's caller, as a PostgREST request runs. */
  async function asCaller<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool().connect();
    try {
      await client.query("begin");
      await client.query("set local track_functions = 'all'");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: SCALE_CALLER, role: "authenticated" }),
      ]);
      return await work(client);
    } finally {
      await client.query("rollback");
      client.release();
    }
  }

  beforeAll(async () => {
    db = await startPostgres();
    await db.admin.query("create database item_gate");
    await db.admin.query(ROLES);
    await db.admin.query("grant authenticated, anon to tester");
    const url = new URL(db.uri);
    url.pathname = "/item_gate";
    scale = new Pool({ connectionString: url.toString() });
    const dir = mkdtempSync(join(tmpdir(), "permdock-gate-"));
    try {
      const out = join(dir, "rls.sql");
      const result = await rlsGenerate(["--target", "sql", "--out", out], {
        cwd: SCALE_PROJECT,
      });
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
      }
      await scale.query(
        `${AUTH}\n${SCALE_TABLES}\n${readFileSync(out, "utf8")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await scale.query(scaleSeed("1k"));
  }, 180_000);

  afterAll(async () => {
    await scale?.end();
    await db?.stop();
  });

  const tenant = uuidOf(KIND.tenant, 0);
  // A tenant the caller holds no membership in.
  const foreign = uuidOf(KIND.tenant, CALLER_TENANTS + 10);
  /** Each reads rows through a tenant or parent key an index covers. */
  const INDEXED: Readonly<Record<string, string>> = {
    itemsTenantPage50: `select id from public.item where "orgId" = '${tenant}' order by id limit 50`,
    itemsTenantCount: `select count(*) from public.item where "orgId" = '${tenant}'`,
    threadsOfTenant: `select id from public.thread where "orgId" = '${tenant}' limit 50`,
    messagesOfOneThread: `select * from public.message where "threadId" = '${uuidOf(KIND.thread, 0)}' limit 50`,
    docsOfOneFolder: `select id from public.doc where "folderId" = '${uuidOf(KIND.folder, 0)}' limit 50`,
  };

  it.each(Object.entries(INDEXED))(
    "%s reads its table through an index",
    async (_name, sql) => {
      const plan = await asCaller(async (client) => {
        // Postgres picks a scan on 1,000 rows whatever the index offers; with
        // sequential scans off, one that remains has no index to use.
        await client.query("set local enable_seqscan = off");
        return explain(client, sql);
      });
      const scans = nodes(plan.Plan)
        .filter((node) => node["Node Type"] === "Seq Scan")
        .map((node) => node["Relation Name"]);
      expect(scans).toStrictEqual([]);
    },
  );

  it.each(Object.entries(INDEXED))(
    "%s runs each helper once and stays under the time ceiling",
    async (name, sql) => {
      const { plan, times } = await asCaller(async (client) => {
        await explain(client, sql);
        const runs: Explained[number][] = [];
        for (let run = 0; run < WARM_RUNS; run += 1) {
          runs.push(await explain(client, sql));
        }
        return {
          plan: runs.at(-1),
          times: runs.map((item) => item["Execution Time"]),
        };
      });
      const helpers = (plan === undefined ? [] : nodes(plan.Plan)).filter(
        callsHelper,
      );
      expect(helpers.length).toBeGreaterThan(0);
      for (const node of helpers) {
        expect(node["Actual Loops"]).toBeLessThanOrEqual(1);
      }
      reportMs(name, median(times));
      expect(median(times)).toBeLessThan(TIME_CEILING_MS);
    },
  );

  // Postgres does not inline a security definer function, so a per-row call
  // hides inside the helper's Function Scan; the function statistics count it.
  it.each([
    ["doc", "doc.read"],
    ["folder", "folder.read"],
  ])(
    "permitted_%s_rows of a walk resource never calls the per-row match",
    async (name, permission) => {
      const { calls, ms } = await asCaller(async (client) => {
        const started = performance.now();
        await client.query(
          `select count(*) from public.${name} where id in (select permdock.permitted_${name}_rows('${permission}'))`,
        );
        const elapsed = performance.now() - started;
        const stats = await client.query<{ calls: string }>(
          `select coalesce(sum(calls), 0) as calls from pg_stat_xact_user_functions where funcname = 'permitted_${name}_match'`,
        );
        return { calls: Number(stats.rows[0]?.calls ?? 0), ms: elapsed };
      });
      expect(calls).toBe(0);
      expect(ms).toBeLessThan(TIME_CEILING_MS * 4);
    },
  );

  // `_by_permission` reads the caller's memberships once for all its grant
  // keys, so it never calls `permitted_<scope>_ids` once per key.
  it.each(["item.read", "item.update"])(
    "permitted_tenant_ids_by_permission('%s') reads the memberships once",
    async (permission) => {
      const { helperCalls, scans, ms } = await asCaller(async (client) => {
        const counters = async () => {
          const calls = await client.query<{ calls: string }>(
            `select coalesce(sum(calls), 0) as calls from pg_stat_xact_user_functions where funcname = 'permitted_tenant_ids'`,
          );
          const reads = await client.query<{ scans: string }>(
            `select coalesce(sum(seq_scan + idx_scan), 0) as scans from pg_stat_xact_user_tables where relname = 'organization_members'`,
          );
          return {
            calls: Number(calls.rows[0]?.calls ?? 0),
            scans: Number(reads.rows[0]?.scans ?? 0),
          };
        };
        const before = await counters();
        const started = performance.now();
        await client.query(
          `select count(*) from permdock.permitted_tenant_ids_by_permission('${permission}')`,
        );
        const elapsed = performance.now() - started;
        const after = await counters();
        return {
          helperCalls: after.calls - before.calls,
          scans: after.scans - before.scans,
          ms: elapsed,
        };
      });
      reportMs(`byPermission.${permission}`, ms);
      expect(helperCalls).toBe(0);
      expect(scans).toBe(1);
    },
  );

  it("keeps the fixed helper cost of a statement under the ceilings", async () => {
    const sql = `select id from public.item where "orgId" = '${foreign}'`;
    const client = await pool().connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: SCALE_CALLER, role: "authenticated" }),
      ]);
      const cold = await explain(client, sql);
      const warm = [];
      for (let run = 0; run < WARM_RUNS; run += 1) {
        warm.push((await explain(client, sql))["Execution Time"]);
      }
      expect(cold["Execution Time"]).toBeLessThan(HELPER_COLD_CEILING_MS);
      reportMs("helperFixedCost.cold", cold["Execution Time"]);
      reportMs("helperFixedCost.warm", median(warm));
      expect(median(warm)).toBeLessThan(HELPER_WARM_CEILING_MS);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
