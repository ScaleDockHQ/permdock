import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres17 } from "../src/support/postgres-17.ts";

import { run } from "../src/support/cli-run.ts";
import { startPostgres17 } from "../src/support/postgres-17.ts";

/**
 * Times the token hook and measures the claims it issues with the memberships
 * claim within the default budget (`on`), with a budget no cell reaches
 * (`unbounded`) and with `supabase.hook.membershipsClaim: false` (`off`).
 * `PERMDOCK_HOOK_BENCH=1` runs it, `PERMDOCK_HOOK_BENCH_WRITE=1` writes
 * `scripts/hook-bench.json`; run it through `node scripts/hook-bench.ts`.
 */
const enabled = process.env["PERMDOCK_HOOK_BENCH"] === "1";
const BASELINE = join(import.meta.dirname, "../../../scripts/hook-bench.json");
const FIXTURES = join(import.meta.dirname, "../fixtures/hook-bench");
const MODES = ["on", "unbounded", "off"] as const;
const COUNTS = [1, 50, 150, 500] as const;
const RUNS = 25;
const ROLES = ["owner", "admin", "member", "viewer"] as const;

type Mode = (typeof MODES)[number];
type Timing = { readonly median: number; readonly p95: number };
type Cell = {
  readonly mode: Mode;
  readonly memberships: number;
  readonly fullReadMs: Timing;
  readonly refreshMs: Timing;
  readonly claimsBytes: number;
  readonly membershipsClaimBytes: number;
  readonly keptMemberships: number;
  readonly truncated: boolean;
  readonly cookieBytes: number;
  readonly cookieChunks: number;
};

const userOf = (count: number): string =>
  `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`;
const orgOf = (n: number): string => `O${String(n).padStart(4, "0")}`;

const CLUSTER = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
create role service_role nologin bypassrls;
`;

const DATABASE = `
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to supabase_auth_admin, authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon, supabase_auth_admin;
grant select on auth.users to supabase_auth_admin;
grant usage on schema public to authenticated, anon;
create table memberships (user_id uuid not null, scope text not null, scope_id text not null, role text not null);
`;

const SEED = `
insert into auth.users (id) values ${COUNTS.map((count) => `('${userOf(count)}')`).join(", ")};
${COUNTS.map(
  (count) => `insert into memberships
  select '${userOf(count)}', 'organization', 'O' || lpad(n::text, 4, '0'),
    (array[${ROLES.map((role) => `'${role}'`).join(", ")}])[1 + n % ${ROLES.length}]
  from generate_series(1, ${count}) n;`,
).join("\n")}
`;

/** One warm-up call, then `p_runs` timed calls on the server, as the caller. */
const TIMER = `
create function public.bench_hook(p_event jsonb, p_runs integer)
returns table (ms double precision, claims jsonb)
language plpgsql
as $$
declare
  t0 timestamptz;
  answer jsonb;
begin
  perform permdock.custom_access_token_hook(p_event);
  for i in 1..p_runs loop
    t0 := clock_timestamp();
    answer := permdock.custom_access_token_hook(p_event);
    ms := extract(epoch from clock_timestamp() - t0) * 1000;
    claims := answer -> 'claims';
    return next;
  end loop;
end;
$$;
grant execute on function public.bench_hook(jsonb, integer) to supabase_auth_admin;
`;

/** The claims Supabase Auth puts in a token before the hook runs. */
function baseClaims(user: string): Record<string, unknown> {
  return {
    aud: "authenticated",
    exp: 1_900_000_000,
    iat: 1_899_996_400,
    iss: "https://abcdefghijklmnopqrst.supabase.co/auth/v1",
    sub: user,
    email: "someone.with.a.long.address@example-company.com",
    phone: "",
    app_metadata: {
      provider: "email",
      providers: ["email"],
      active_organization: orgOf(1),
    },
    user_metadata: {},
    role: "authenticated",
    aal: "aal1",
    amr: [{ method: "password", timestamp: 1_899_996_400 }],
    session_id: "11111111-2222-4333-8444-555555555555",
    is_anonymous: false,
  };
}

function timing(samples: readonly number[]): Timing {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (rank: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? Number.NaN;
  const round = (ms: number): number => Math.round(ms * 1000) / 1000;
  return {
    median: round(at(Math.floor((sorted.length - 1) / 2))),
    p95: round(at(Math.ceil(sorted.length * 0.95) - 1)),
  };
}

/**
 * better-supabase BS405: claims times 4/3 plus 1,700 bytes, in 3,180-byte
 * chunks.
 */
function cookie(claimsBytes: number): {
  readonly bytes: number;
  readonly chunks: number;
} {
  const bytes = Math.ceil((claimsBytes * 4) / 3) + 1700;
  return { bytes, chunks: Math.ceil(bytes / 3180) };
}

async function timed(
  client: Client,
  event: Record<string, unknown>,
): Promise<{
  readonly samples: readonly number[];
  readonly claims: Record<string, unknown>;
}> {
  await client.query("begin");
  try {
    await client.query("set local role supabase_auth_admin");
    const { rows } = await client.query<{
      ms: number;
      claims: Record<string, unknown>;
    }>("select ms, claims from public.bench_hook($1::jsonb, $2)", [
      JSON.stringify(event),
      RUNS,
    ]);
    const last = rows.at(-1);
    if (last === undefined) {
      throw new Error("PermDock bench: the hook returned no rows");
    }
    return { samples: rows.map((row) => row.ms), claims: last.claims };
  } finally {
    await client.query("rollback");
  }
}

async function generatedSql(mode: Mode): Promise<readonly string[]> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-hook-bench-"));
  try {
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--schemas",
        "migrations",
        "--split",
        "helpers,hook",
        "--out",
        `${dir}/{part}.sql`,
      ],
      { cwd: join(FIXTURES, mode) },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate ${mode}: ${result.stdout}${result.stderr}`);
    }
    return ["helpers", "hook"].map((part) =>
      readFileSync(join(dir, `${part}.sql`), "utf8"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(enabled)(
  "the token hook with the memberships claim on and off",
  () => {
    let cluster: Postgres17 | undefined;
    const cells: Cell[] = [];

    beforeAll(async () => {
      cluster = await startPostgres17();
      const admin = new Client({ connectionString: cluster.url });
      await admin.connect();
      try {
        await admin.query(CLUSTER);
        for (const mode of MODES) {
          await admin.query(`create database bench_${mode}`);
        }
      } finally {
        await admin.end();
      }
      for (const mode of MODES) {
        const url = new URL(cluster.url);
        url.pathname = `/bench_${mode}`;
        const client = new Client({ connectionString: url.toString() });
        await client.connect();
        try {
          // Seeded before the generated triggers, which would refuse a tenant whose seed rows hold no owner yet.
          await client.query(DATABASE);
          await client.query(SEED);
          for (const sql of await generatedSql(mode)) {
            await client.query(sql);
          }
          await client.query(`${TIMER}\nanalyze;`);
          for (const count of COUNTS) {
            const user = userOf(count);
            const full = await timed(client, {
              user_id: user,
              authentication_method: "password",
              claims: baseClaims(user),
            });
            const refresh = await timed(client, {
              user_id: user,
              authentication_method: "token_refresh",
              claims: full.claims,
            });
            const memberships = full.claims["memberships"];
            const kept = Array.isArray(memberships) ? memberships.length : -1;
            const claimsBytes = Buffer.byteLength(JSON.stringify(full.claims));
            const { bytes, chunks } = cookie(claimsBytes);
            cells.push({
              mode,
              memberships: count,
              fullReadMs: timing(full.samples),
              refreshMs: timing(refresh.samples),
              claimsBytes,
              membershipsClaimBytes: Buffer.byteLength(
                JSON.stringify(memberships),
              ),
              keptMemberships: kept,
              truncated: full.claims["memberships_truncated"] === true,
              cookieBytes: bytes,
              cookieChunks: chunks,
            });
          }
        } finally {
          await client.end();
        }
      }
    }, 600_000);

    afterAll(async () => {
      await cluster?.stop();
    });

    it("keeps every entry unbounded, none with the claim off, and a budgeted prefix on", () => {
      for (const cell of cells) {
        switch (cell.mode) {
          case "unbounded":
            expect(cell).toMatchObject({
              keptMemberships: cell.memberships,
              truncated: false,
            });
            break;
          case "off":
            expect(cell).toMatchObject({ keptMemberships: 0, truncated: true });
            break;
          case "on":
            expect(cell.membershipsClaimBytes).toBeLessThanOrEqual(1024);
            expect(cell.truncated).toBe(
              cell.keptMemberships < cell.memberships,
            );
            break;
          default: {
            const never: never = cell.mode;
            throw new Error(`PermDock bench: unknown mode ${String(never)}`);
          }
        }
      }
    });

    it("matches the recorded claim bytes, or records them", () => {
      const report = {
        $comment:
          "node scripts/hook-bench.ts --write; times are a median and p95 of server-side clock_timestamp() around each hook call, bytes are exact",
        measuredOn: `${platform()} ${arch()}, ${cpus()[0]?.model ?? "unknown CPU"}`,
        runs: RUNS,
        cells,
      };
      process.stdout.write(
        `${cells
          .map(
            (cell) =>
              `HOOK-BENCH ${cell.mode} n=${String(cell.memberships)} full=${String(cell.fullReadMs.median)}/${String(cell.fullReadMs.p95)}ms refresh=${String(cell.refreshMs.median)}/${String(cell.refreshMs.p95)}ms claims=${String(cell.claimsBytes)}B memberships=${String(cell.membershipsClaimBytes)}B kept=${String(cell.keptMemberships)} chunks=${String(cell.cookieChunks)}`,
          )
          .join("\n")}\n`,
      );
      if (process.env["PERMDOCK_HOOK_BENCH_WRITE"] === "1") {
        writeFileSync(BASELINE, `${JSON.stringify(report, null, 2)}\n`);
        return;
      }
      // SAFETY: the file is the report this test wrote with PERMDOCK_HOOK_BENCH_WRITE.
      const recorded = JSON.parse(readFileSync(BASELINE, "utf8")) as {
        readonly cells: readonly Cell[];
      };
      const bytesOf = (list: readonly Cell[]) =>
        list.map(({ mode, memberships, claimsBytes, keptMemberships }) => ({
          mode,
          memberships,
          claimsBytes,
          keptMemberships,
        }));
      expect(bytesOf(cells)).toStrictEqual(bytesOf(recorded.cells));
    });
  },
);
