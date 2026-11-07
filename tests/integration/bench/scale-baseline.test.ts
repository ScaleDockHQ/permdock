import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";
import type { Cell, RowTier } from "./fixtures/scale/tiers.ts";

import { AUTH, ROLES } from "../src/support/declarative-fixtures.ts";
import { startPostgres } from "../src/support/postgres.ts";
import { rlsGenerate } from "../src/support/rls.ts";
import {
  ATTACHMENTS_DDL,
  JOBS_POLICY_PER_ROW,
  customRolesSeed,
  jobsSeed,
  membershipSeed,
} from "./fixtures/scale/lienlink-seed.ts";
import {
  CALLER_TENANTS,
  SCALE_CALLER,
  SCALE_TABLES,
  scaleSeed,
} from "./fixtures/scale/scale-seed.ts";
import {
  CELLS,
  KIND,
  ROW_TIERS,
  callerOf,
  cellKey,
  uuidOf,
} from "./fixtures/scale/tiers.ts";

/**
 * Records baselines for the scale audit: `PERMDOCK_SCALE=1` runs it,
 * `PERMDOCK_SCALE_TIER` picks 1k, 100k (default) or 1M rows, and
 * `PERMDOCK_SCALE_WRITE=1` writes `baselines/scale-<tier>.json`. Run it through
 * `pnpm bench:scale`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const JOBS_FIXTURE = join(HERE, "../fixtures/declarative-jobs");
const SCALE_PROJECT = join(HERE, "fixtures/scale/project");
const BASELINES = join(HERE, "baselines");
const STATEMENT_TIMEOUT_MS = Number(
  process.env["PERMDOCK_SCALE_TIMEOUT_MS"] ?? 120_000,
);
const WARM_RUNS = 3;
const SLOW_MS = 5_000;

const enabled = process.env["PERMDOCK_SCALE"] === "1";
const tierName = process.env["PERMDOCK_SCALE_TIER"] ?? "100k";
const tier: RowTier =
  tierName === "1k" || tierName === "1M" || tierName === "100k"
    ? tierName
    : "100k";

type Plan = {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Actual Loops": number;
  readonly "Shared Hit Blocks"?: number;
  readonly "Shared Read Blocks"?: number;
  readonly Plans?: readonly Plan[];
};
type Explained = readonly [
  {
    readonly Plan: Plan;
    readonly "Planning Time": number;
    readonly "Execution Time": number;
  },
];

type Timing =
  | {
      readonly firstMs: number;
      readonly warmMs: readonly number[];
      readonly medianMs: number;
      readonly warmRuns: number;
      readonly planningMs: number;
      readonly seqScans: readonly string[];
      readonly maxLoops: number;
      readonly sharedHit: number;
      readonly sharedRead: number;
    }
  | { readonly timedOut: true; readonly afterMs: number }
  | { readonly error: string };

const CUSTOM_ROWS_NOTE =
  "c50 tiers read a 400,000-row permdock.custom_role_permissions; c500 tiers read 4,000,000 rows (500 roles × 1,000 tenants × 8 grants).";

const read = (rel: string): string =>
  readFileSync(join(JOBS_FIXTURE, rel), "utf8");

function walk(plan: Plan, seen: { seq: Set<string>; loops: number }): void {
  if (plan["Node Type"] === "Seq Scan" && plan["Relation Name"] !== undefined) {
    seen.seq.add(plan["Relation Name"]);
  }
  seen.loops = Math.max(seen.loops, plan["Actual Loops"]);
  for (const child of plan.Plans ?? []) {
    walk(child, seen);
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

type Client = Awaited<ReturnType<Pool["connect"]>>;

async function explain(client: Client, sql: string): Promise<Explained> {
  const result = await client.query<{ "QUERY PLAN": Explained }>(
    `explain (analyze, buffers, format json) ${sql}`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("PermDock: explain returned no plan");
  }
  return row["QUERY PLAN"];
}

/** First run, then `WARM_RUNS` more; the last plan gives the shape. */
async function timed(client: Client, sql: string): Promise<Timing> {
  const started = performance.now();
  await client.query("savepoint timed");
  try {
    const first = await explain(client, sql);
    const warm: Explained[] = [];
    // A statement that already takes seconds is not run again, to bound the run.
    for (
      let run = 0;
      run < WARM_RUNS && first[0]["Execution Time"] < SLOW_MS;
      run += 1
    ) {
      warm.push(await explain(client, sql));
    }
    const last = warm.at(-1) ?? first;
    const seen = { seq: new Set<string>(), loops: 0 };
    walk(last[0].Plan, seen);
    const warmMs = warm.map((plan) => round(plan[0]["Execution Time"]));
    const firstOnly = warmMs.length === 0;
    return {
      firstMs: round(first[0]["Execution Time"]),
      warmMs,
      medianMs: firstOnly
        ? round(first[0]["Execution Time"])
        : round(median(warmMs)),
      warmRuns: warmMs.length,
      planningMs: round(last[0]["Planning Time"]),
      seqScans: [...seen.seq].sort(),
      maxLoops: seen.loops,
      sharedHit: last[0].Plan["Shared Hit Blocks"] ?? 0,
      sharedRead: last[0].Plan["Shared Read Blocks"] ?? 0,
    };
  } catch (error) {
    await client.query("rollback to savepoint timed");
    const message = error instanceof Error ? error.message : String(error);
    if (/statement timeout/u.test(message)) {
      return {
        timedOut: true,
        afterMs: Math.round(performance.now() - started),
      };
    }
    return { error: message.slice(0, 300) };
  }
}

/**
 * Runs `work` as `user` on a connection in a transaction that rolls back: the
 * claims come from the generated hook, then `authenticated` and the claims
 * apply, as a PostgREST request would.
 */
async function asCaller<T>(
  pool: Pool,
  user: string,
  work: (client: Client) => Promise<T>,
  hooked = true,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const hook = hooked
      ? await client.query<{ claims: unknown }>(
          `select (permdock.custom_access_token_hook(jsonb_build_object(
         'user_id', $1::uuid,
         'claims', jsonb_build_object('sub', $1::uuid, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal1', 'session_id', $1::uuid, 'app_metadata', '{}'::jsonb)
       )) -> 'claims') as claims`,
          [user],
        )
      : { rows: [{ claims: { sub: user, role: "authenticated" } }] };
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(hook.rows[0]?.claims),
    ]);
    return await work(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

async function asAdmin<T>(
  pool: Pool,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return await work(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/** Token length with the Supabase claims a real access token also carries. */
const BASE_CLAIMS = {
  iss: "https://example.supabase.co/auth/v1",
  aud: "authenticated",
  exp: 1_900_000_000,
  iat: 1_900_000_000,
  sub: "00000000-0000-4000-8000-000000000000",
  email: "caller@example.com",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  role: "authenticated",
  aal: "aal1",
  amr: [{ method: "password", timestamp: 1_900_000_000 }],
  session_id: "00000000-0000-4000-8000-000000000000",
  is_anonymous: false,
};
/**
 * Header `{"alg":"ES256","typ":"JWT","kid":<uuid>}` and a 64-byte signature,
 * base64url.
 */
const HEADER_CHARS = 100;
const SIGNATURE_CHARS = 86;

function tokenChars(hookClaims: unknown): number {
  const claims = JSON.stringify({
    ...BASE_CLAIMS,
    ...(typeof hookClaims === "object" && hookClaims !== null
      ? hookClaims
      : {}),
  });
  return (
    HEADER_CHARS +
    1 +
    Math.ceil((Buffer.byteLength(claims) * 4) / 3) +
    1 +
    SIGNATURE_CHARS
  );
}

function gitSha(): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: HERE,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function matrixCell(
  jobs: Pool,
  cell: Cell,
): Promise<Record<string, unknown>> {
  const caller = callerOf(cell);
  const out: Record<string, unknown> = {};
  await asAdmin(jobs, async (client) => {
    const event = `jsonb_build_object('user_id', '${caller}'::uuid, 'claims', jsonb_build_object('sub', '${caller}'::uuid, 'role', 'authenticated', 'aud', 'authenticated', 'aal', 'aal1', 'session_id', '${caller}'::uuid, 'app_metadata', '{}'::jsonb))`;
    out["hook"] = await timed(
      client,
      `select permdock.custom_access_token_hook(${event})`,
    );
    out["subjectFor"] = await timed(
      client,
      `select permdock.subject_for('${caller}'::uuid)`,
    );
    const claims = await client.query<{
      claims: { memberships?: unknown[]; memberships_truncated?: boolean };
      bytes: number;
    }>(
      `select c as claims, octet_length(c::text) as bytes
       from (select permdock.custom_access_token_hook(${event}) -> 'claims' as c) x`,
    );
    const hookClaims = claims.rows[0]?.claims;
    out["claimsBytes"] = claims.rows[0]?.bytes;
    out["membershipsInToken"] = hookClaims?.memberships?.length ?? 0;
    out["membershipsTruncated"] = hookClaims?.memberships_truncated ?? false;
    out["tokenChars"] = tokenChars(hookClaims);
  });
  out["permittedTenantIds"] = await asCaller(jobs, caller, (client) =>
    timed(
      client,
      `select count(*) from permdock.permitted_tenant_ids('jobs.read')`,
    ),
  );
  return out;
}

async function jobsShapes(
  jobs: Pool,
  cell: Cell,
): Promise<Record<string, Timing>> {
  const caller = callerOf(cell);
  const tenant = uuidOf(KIND.tenant, 0);
  const shapes: Record<string, string> = {
    jobsTenantPage50: `select id from public.jobs where organization_id = '${tenant}' order by id limit 50`,
    jobsTenantCount: `select count(*) from public.jobs where organization_id = '${tenant}'`,
    jobsAllCount: `select count(*) from public.jobs`,
    jobsFacetsByTeam: `select team_id, count(*) from public.jobs where organization_id = '${tenant}' group by team_id`,
    jobPartiesOfOneJob: `select * from public.job_parties where job_id = '${uuidOf(KIND.job, 0)}'`,
    jobPartiesCount: `select count(*) from public.job_parties`,
    attachmentsOfOneJob: `select * from public.job_attachments where job_id = '${uuidOf(KIND.job, 0)}'`,
    attachmentsCount: `select count(*) from public.job_attachments`,
  };
  const out: Record<string, Timing> = {};
  await asCaller(jobs, caller, async (client) => {
    for (const [name, sql] of Object.entries(shapes)) {
      out[name] = await timed(client, sql);
    }
  });
  return out;
}

async function scaleShapes(scale: Pool): Promise<Record<string, unknown>> {
  const tenant = uuidOf(KIND.tenant, 0);
  const shapes: Record<string, string> = {
    itemsTenantPage50: `select id from public.item where "orgId" = '${tenant}' order by id limit 50`,
    itemsTenantCount: `select count(*) from public.item where "orgId" = '${tenant}'`,
    itemsAllCount: `select count(*) from public.item`,
    messagesOfOneThread: `select * from public.message where "threadId" = '${uuidOf(KIND.thread, 0)}' limit 50`,
    messagesCount: `select count(*) from public.message`,
    folderRoots: `select id from public.folder where "parentId" is null order by id limit 50`,
    folderCount: `select count(*) from public.folder`,
    docsOfOneFolder: `select id from public.doc where "folderId" = '${uuidOf(KIND.folder, 0)}' limit 50`,
    docsCount: `select count(*) from public.doc`,
    employeeWalkCount: `select count(*) from public.employee`,
    storageObjectsCount: `select count(*) from storage.objects where bucket_id = 'files'`,
    storageObjectsOfTenant: `select count(*) from storage.objects where bucket_id = 'files' and name like '${tenant}/%'`,
  };
  const out: Record<string, unknown> = {};
  await asCaller(
    scale,
    SCALE_CALLER,
    async (client) => {
      for (const [name, sql] of Object.entries(shapes)) {
        out[name] = await timed(client, sql);
      }
    },
    false,
  );
  await asAdmin(scale, async (client) => {
    out["approvalList50"] = await timed(
      client,
      `select permdock.permdock_approval_list('{}'::jsonb, null, null, 50)`,
    );
    out["approvalGet"] = await timed(
      client,
      `select permdock.permdock_approval_get('t-0')`,
    );
    const started = performance.now();
    await client.query(`
      insert into public.folder (id, "parentId", restricted, "ownerId")
      select ('00000000-0000-4fff-8000-' || lpad(to_hex(n), 12, '0'))::uuid, null, false, null
      from generate_series(1, 1000) n`);
    out["closureInsert1000Folders"] = {
      ms: round(performance.now() - started),
    };
  });
  return out;
}

describe.runIf(enabled)(`scale baseline, ${tier} rows`, () => {
  let db: Postgres | undefined;
  let jobs: Pool | undefined;
  let scale: Pool | undefined;
  const seedMs: Record<string, number> = {};
  const rowsOf = ROW_TIERS[tier];

  const started = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };
  const pools = (): { readonly jobs: Pool; readonly scale: Pool } => {
    if (jobs === undefined || scale === undefined) {
      throw new Error("PermDock: pools were not opened");
    }
    return { jobs, scale };
  };
  const uriOf = (name: string): string => {
    const url = new URL(started().uri);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const timedApply = async (
    label: string,
    pool: Pool,
    sql: string,
  ): Promise<void> => {
    const started = performance.now();
    await pool.query(sql);
    seedMs[label] = Math.round(performance.now() - started);
  };

  beforeAll(
    async () => {
      db = await startPostgres();
      await db.admin.query("create database jobs_scale");
      await db.admin.query("create database item_scale");
      await db.admin.query(ROLES);
      await db.admin.query("grant authenticated, anon to tester");
      jobs = new Pool({ connectionString: uriOf("jobs_scale") });
      scale = new Pool({ connectionString: uriOf("item_scale") });

      const generated = [
        "supabase/schemas/permdock/helpers.sql",
        "supabase/schemas/permdock/hook.sql",
        "supabase/schemas/permdock/follows.sql",
      ].map(read);
      await jobs.query(
        `${AUTH}\n${read("supabase/schemas/public/tables.sql")}\n${generated.join("\n")}\n${ATTACHMENTS_DDL}\n${JOBS_POLICY_PER_ROW}`,
      );
      await timedApply("jobsAndTenants", jobs, jobsSeed(tier));
      await timedApply("membershipMatrix", jobs, membershipSeed());

      const dir = mkdtempSync(join(tmpdir(), "permdock-scale-"));
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
      await timedApply("scaleRows", scale, scaleSeed(tier));
      await timedApply(
        "approvals",
        scale,
        `insert into permdock.approval_requests (token, body, status, tenant, principal_id, created_at, expires_at)
       select 't-' || n, '{}'::jsonb, case when n % 3 = 0 then 'approved' else 'pending' end,
              '${uuidOf(KIND.tenant, 0)}', 'p' || n % 50, to_char(now() - (n || ' seconds')::interval, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              now() + interval '1 day'
       from generate_series(0, ${Math.max(Math.floor(rowsOf / 10), 1) - 1}) n`,
      );
      await scale.query("analyze");
    },
    6 * 60 * 60_000,
  );

  afterAll(async () => {
    await jobs?.end();
    await scale?.end();
    await db?.stop();
  });

  it(
    "records the matrix and the shapes",
    async () => {
      const pool = pools().jobs;
      const matrix: Record<string, unknown> = {};
      const lienlink: Record<string, unknown> = {};
      const record: Record<string, unknown> = {
        recordedAt: new Date().toISOString(),
        commit: gitSha(),
        tier,
        rows: rowsOf,
        tenants: 1000,
        callerTenants: CALLER_TENANTS,
        postgres: "postgres:16-alpine (testcontainers, default settings)",
        statementTimeoutMs: STATEMENT_TIMEOUT_MS,
        note: "Timings are Execution Time from EXPLAIN (ANALYZE, BUFFERS); firstMs is the first run on a warm container, warmMs the next runs (none when the first run took over 5 s; medianMs is then firstMs). A timedOut entry hit statementTimeoutMs. Generated SQL is main, as of the commit. The full membership, role and custom-role matrix runs on the 100k tier only; other tiers record the two Lienlink callers.",
        seedMs,
        customRolePermissionRows: CUSTOM_ROWS_NOTE,
        matrix,
        lienlinkJobs: lienlink,
      };
      const flush = (): void => {
        if (process.env["PERMDOCK_SCALE_WRITE"] === "1") {
          mkdirSync(BASELINES, { recursive: true });
          writeFileSync(
            join(BASELINES, `scale-${tier}.json`),
            `${JSON.stringify(record, null, 2)}\n`,
          );
        }
      };
      record["scale"] = await scaleShapes(pools().scale);
      flush();
      const full = tier === "100k";
      const stages = full ? [0, 50, 500] : [0, 500];
      let seeded = 0;
      for (const custom of stages) {
        if (custom > seeded) {
          await timedApply(
            `customRolesTo${String(custom)}`,
            pool,
            customRolesSeed(seeded, custom),
          );
          seeded = custom;
        }
        const typical = [
          { memberships: 1, roles: 1, custom },
          { memberships: 12, roles: 5, custom },
        ] satisfies Cell[];
        const cells = full
          ? CELLS.filter((item) => item.custom === custom)
          : typical;
        for (const cell of cells) {
          matrix[cellKey(cell)] = await matrixCell(pool, cell);
          flush();
        }
        for (const cell of typical) {
          lienlink[cellKey(cell)] = await jobsShapes(pool, cell);
          flush();
        }
      }
      expect(Object.keys(matrix).length).toBeGreaterThan(0);
    },
    6 * 60 * 60_000,
  );
});
