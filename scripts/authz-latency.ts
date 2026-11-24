/* oxlint-disable max-lines-per-function, no-await-in-loop -- a measurement driver: each timed run waits for the one before it */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Measures the request costs of plan section 12 against the running local
 * Supabase stack of `apps/examples/next-better-supabase` and writes
 * `scripts/authz-latency.json`: `node scripts/authz-latency.ts`. Start the
 * stack first (`pnpm --filter @permdock/example-next-better-supabase
 * supabase:start`) and build `permdock`. It reads the seed users only; every
 * statement runs as `postgres` or in a transaction it rolls back, and the
 * variant helpers live in the session's `pg_temp` schema.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = join(ROOT, "apps", "examples", "next-better-supabase");
const FIXTURE = join(
  ROOT,
  "tests",
  "integration",
  "fixtures",
  "generate-perf",
  "policy.ts",
);
const OUT = join(ROOT, "scripts", "authz-latency.json");

const OLIVIA = "00000000-0000-4000-8000-0000000000a1";
const ACME = "00000000-0000-4000-8000-0000000000b1";
const RUNS = 200;
const WARMUP = 20;
const COLD_RUNS = 30;
const CALLS = 10_000;
/** The plan's threshold for shipping a compiled policy index (section 12.4). */
const COLD_THRESHOLD_MS = 3;
/** A section 12.5 variant ships only if it cuts the helper's mean by this. */
const VARIANT_CUT = 0.2;

type Row = Readonly<Record<string, unknown>>;
type QueryResult = { readonly rows: readonly Row[] };
type PgClient = {
  readonly connect: () => Promise<void>;
  readonly query: (
    text:
      | string
      | {
          readonly name: string;
          readonly text: string;
          readonly values: readonly string[];
        },
    values?: readonly string[],
  ) => Promise<QueryResult | readonly QueryResult[]>;
  readonly end: () => Promise<void>;
};
type PgModule = {
  readonly default: {
    readonly Client: new (config: { connectionString: string }) => PgClient;
  };
};
type Instance = {
  readonly can: (permission: unknown, row?: unknown) => boolean;
};
type PermDockModule = {
  readonly getPermDock: (
    policy: unknown,
    user: unknown,
    options?: Readonly<Record<string, unknown>>,
  ) => Promise<Instance>;
  readonly instanceCache: () => unknown;
  readonly memoryVersionCache: () => unknown;
};
type BetterSupabaseModule = {
  readonly grantFingerprint: (
    permdock: Instance,
    permissions: readonly string[],
  ) => unknown;
  readonly permdockFor: (options: Readonly<Record<string, unknown>>) => unknown;
  readonly authorizationHooks: (options: Readonly<Record<string, unknown>>) => {
    readonly shareKey: (
      authorizer: undefined,
      keys: readonly string[],
      input: Readonly<Record<string, unknown>>,
    ) => Promise<unknown>;
  };
};
type PolicyModule = {
  readonly policy: unknown;
  readonly permissions: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
};

type Stats = {
  readonly runs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
};
type NotMeasured = { readonly measured: false; readonly reason: string };

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function stats(samples: readonly number[]): Stats {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    runs: sorted.length,
    meanMs: round(mean),
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
  };
}

async function timed(
  runs: number,
  run: () => Promise<unknown>,
): Promise<number[]> {
  for (let index = 0; index < WARMUP; index += 1) await run();
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return samples;
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function single(result: QueryResult | readonly QueryResult[]): QueryResult {
  if ("rows" in result) return result;
  throw new TypeError("expected one statement result");
}

function many(
  result: QueryResult | readonly QueryResult[],
): readonly QueryResult[] {
  return "rows" in result ? [result] : result;
}

function stringAt(record: unknown, key: string): string {
  const value = isRow(record) ? record[key] : undefined;
  if (typeof value !== "string") throw new TypeError(`missing ${key}`);
  return value;
}

function numberAt(record: unknown, key: string): number {
  const value = isRow(record) ? record[key] : undefined;
  if (typeof value !== "number") throw new TypeError(`missing ${key}`);
  return value;
}

/** The root workspace depends on neither, so both resolve from the example. */
const fromExample = createRequire(join(EXAMPLE, "package.json"));

async function load(specifier: string): Promise<unknown> {
  // Dynamic: `pg` and `permdock` resolve only from the example's node_modules.
  const module: unknown = await import(
    pathToFileURL(fromExample.resolve(specifier)).href
  );
  return module;
}

function stack(): { db: string; rest: string; publishable: string } {
  const status = spawnSync(
    "pnpm",
    ["exec", "supabase", "status", "--output-format", "json"],
    { cwd: EXAMPLE, encoding: "utf8" },
  );
  if (status.status !== 0) {
    throw new Error(
      `supabase status failed; start the example stack first:\n${status.stderr}`,
    );
  }
  const parsed: unknown = JSON.parse(status.stdout);
  const env = isRow(parsed) ? parsed["env"] : undefined;
  return {
    db: stringAt(env, "DB_URL"),
    rest: stringAt(env, "REST_URL"),
    publishable: stringAt(env, "PUBLISHABLE_KEY"),
  };
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

type Explained = {
  readonly executionMs: number;
  readonly sharedHit: number;
  readonly sharedRead: number;
};

function explained(result: QueryResult | undefined): Explained {
  const plans = result?.rows[0]?.["QUERY PLAN"];
  const top: unknown = Array.isArray(plans) ? plans[0] : undefined;
  const plan = isRow(top) ? top["Plan"] : undefined;
  return {
    executionMs: numberAt(top, "Execution Time"),
    sharedHit: numberAt(plan, "Shared Hit Blocks"),
    sharedRead: numberAt(plan, "Shared Read Blocks"),
  };
}

type ServerStats = Stats & { readonly sharedHitBlocks: number };

/**
 * Server time from `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF)`, `RUNS` times per
 * statement. Several statements alternate run by run, so drift on the shared
 * machine reaches each of them alike.
 */
async function serverTimes(
  client: PgClient,
  sqls: readonly string[],
  wrap: (explain: string) => string = (explain) => explain,
  index = 0,
): Promise<ServerStats[]> {
  const samples = sqls.map((): number[] => []);
  const last: (Explained | null)[] = sqls.map(() => null);
  for (let run = 0; run < WARMUP + RUNS; run += 1) {
    for (const [at, sql] of sqls.entries()) {
      const explain = `explain (analyze, buffers, timing off, format json) ${sql}`;
      const result = explained(many(await client.query(wrap(explain)))[index]);
      last[at] = result;
      if (run >= WARMUP) samples[at]?.push(result.executionMs);
    }
  }
  return samples.map((taken: readonly number[], at) => ({
    ...stats(taken),
    sharedHitBlocks: last[at]?.sharedHit ?? 0,
  }));
}

async function serverTime(client: PgClient, sql: string): Promise<ServerStats> {
  const [only] = await serverTimes(client, [sql]);
  if (only === undefined) throw new TypeError("no server time");
  return only;
}

async function claimsOf(client: PgClient, user: string): Promise<string> {
  const hooked = single(
    await client.query(
      "select permdock.custom_access_token_hook(jsonb_build_object('user_id', $1::text, 'claims', jsonb_build_object('sub', $1::text, 'role', 'authenticated'))) -> 'claims' as claims",
      [user],
    ),
  ).rows[0]?.["claims"];
  if (!isRow(hooked)) throw new TypeError("the token hook returned no claims");
  return JSON.stringify(hooked);
}

async function versionReads(
  client: PgClient,
  rest: string,
  publishable: string,
): Promise<Row> {
  const pg = async (
    name: string,
    text: string,
    value: string,
  ): Promise<number[]> => {
    const samples = await timed(RUNS, async () => {
      await client.query({ name, text, values: [value] });
    });
    return samples;
  };
  const call = async (): Promise<void> => {
    const response = await fetch(
      `${rest}/organizations?select=id&id=eq.${ACME}`,
      { headers: { apikey: publishable } },
    );
    if (!response.ok) throw new Error(`PostgREST ${response.status}`);
    await response.arrayBuffer();
  };
  const postgrest = async (): Promise<Stats | NotMeasured> => {
    try {
      return stats(await timed(RUNS, call));
    } catch (error) {
      return { measured: false, reason: String(error) };
    }
  };
  const notExposed: NotMeasured = {
    measured: false,
    reason:
      "the example sets no supabase.hook.api, so no public wrapper exposes it and the permdock schema is not in the API's schemas",
  };
  return {
    authzVersionFor: {
      function: "permdock.authz_version_for(uuid)",
      pgRoundTrip: stats(
        await pg(
          "authz_version_for",
          "select permdock.authz_version_for($1::uuid)",
          OLIVIA,
        ),
      ),
      server: await serverTime(
        client,
        `select permdock.authz_version_for(${literal(OLIVIA)}::uuid)`,
      ),
      postgrestRpc: notExposed,
    },
    customRolesVersionFor: {
      function: "permdock.custom_roles_version_for(uuid)",
      pgRoundTrip: stats(
        await pg(
          "custom_roles_version_for",
          "select permdock.custom_roles_version_for($1::uuid)",
          ACME,
        ),
      ),
      server: await serverTime(
        client,
        `select permdock.custom_roles_version_for(${literal(ACME)}::uuid)`,
      ),
      postgrestRpc: notExposed,
    },
    postgrestRpcFloor: {
      note: "GET /organizations?select=id&id=eq.<acme> as anon: a one-row primary-key read, the round trip a version wrapper would add over PostgREST",
      ...(await postgrest()),
    },
  };
}

type ColdSample = Readonly<Record<string, number>>;

function coldRun(code: string, cwd: string): ColdSample {
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", code],
    { cwd, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`cold run failed:\n${run.stderr}`);
  const parsed: unknown = JSON.parse(run.stdout);
  if (!isRow(parsed)) throw new TypeError("cold run printed no marks");
  const marks: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number") marks[key] = value;
  }
  return marks;
}

function segments(
  samples: readonly ColdSample[],
  order: readonly string[],
): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  for (let index = 1; index < order.length; index += 1) {
    const from = order[index - 1] ?? "";
    const to = order[index] ?? "";
    out[to] = stats(samples.map((s) => (s[to] ?? 0) - (s[from] ?? 0)));
  }
  return out;
}

/**
 * A fresh `node` per run. `policyModule` covers the module up to its
 * `definePolicy` call, `definePolicy` the call with its role and grant
 * builders. The warm variant imports everything first, as an
 * `instrumentation.ts` `register()` would, and times only the first request.
 */
function coldInstance(
  name: string,
  cwd: string,
  imports: { readonly before: string; readonly policy: string },
  build: { readonly principal: string; readonly check: string },
): Row {
  const cold = `
const m = { start: performance.now() };
const pd = await import("permdock");
m.permdock = performance.now();
${imports.before}
m.policyModule = globalThis.__pdBeforeDefine ?? performance.now();
const { policy, permissions } = await import(${JSON.stringify(imports.policy)});
m.definePolicy = performance.now();
m.policyModule = globalThis.__pdBeforeDefine ?? m.policyModule;
const instance = await pd.getPermDock(policy, ${build.principal});
m.getPermDock = performance.now();
instance.can(${build.check});
m.can = performance.now();
process.stdout.write(JSON.stringify(m));`;
  const warm = `
const pd = await import("permdock");
${imports.before}
const { policy, permissions } = await import(${JSON.stringify(imports.policy)});
const m = { start: performance.now() };
const instance = await pd.getPermDock(policy, ${build.principal});
m.getPermDock = performance.now();
instance.can(${build.check});
m.can = performance.now();
await pd.getPermDock(policy, ${build.principal});
m.secondGetPermDock = performance.now();
process.stdout.write(JSON.stringify(m));`;
  const coldSamples = Array.from({ length: COLD_RUNS }, () =>
    coldRun(cold, cwd),
  );
  const warmSamples = Array.from({ length: COLD_RUNS }, () =>
    coldRun(warm, cwd),
  );
  const total = stats(
    coldSamples.map((s) => (s["can"] ?? 0) - (s["permdock"] ?? 0)),
  );
  const indexed = stats(
    coldSamples.map((s) => (s["can"] ?? 0) - (s["policyModule"] ?? 0)),
  );
  return {
    policy: name,
    cold: {
      marks: segments(coldSamples, [
        "start",
        "permdock",
        "policyModule",
        "definePolicy",
        "getPermDock",
        "can",
      ]),
      build: total,
      buildNote:
        "policy module, definePolicy, first getPermDock and first can; the permdock import is excluded",
      overThreshold: total.meanMs > COLD_THRESHOLD_MS,
      evaluatorAndInstance: indexed,
      evaluatorAndInstanceNote:
        "definePolicy, first getPermDock and first can: the part a compiled policy index replaces",
      evaluatorAndInstanceOverThreshold: indexed.meanMs > COLD_THRESHOLD_MS,
    },
    warm: segments(warmSamples, [
      "start",
      "getPermDock",
      "can",
      "secondGetPermDock",
    ]),
  };
}

function coldInstances(): Row {
  const dir = join(ROOT, "tests", "integration", "tmp");
  mkdirSync(dir, { recursive: true });
  const copy = mkdtempSync(join(dir, "authz-latency-"));
  try {
    const source = readFileSync(FIXTURE, "utf8");
    const marker = "export const policy = definePolicy(";
    if (!source.includes(marker)) {
      throw new Error(`${FIXTURE} no longer calls ${marker}`);
    }
    writeFileSync(
      join(copy, "policy.ts"),
      source.replace(
        marker,
        `globalThis.__pdBeforeDefine = performance.now();\n${marker}`,
      ),
    );
    return {
      fixture: coldInstance(
        "tests/integration/fixtures/generate-perf: 273 keys, 1,790 admin grants",
        copy,
        { before: "", policy: "./policy.ts" },
        {
          principal: `{ id: "u-o0", tenant: "o0", memberships: [{ scope: "tenant", id: "o0", roles: ["admin"] }] }`,
          check: `permissions.res00.read, { id: "r1", orgId: "o0", status: "s0" }`,
        },
      ),
      example: coldInstance(
        "apps/examples/next-better-supabase/src/policy.ts: 8 keys, 4 roles",
        EXAMPLE,
        {
          before: `await import("./src/permissions.ts");`,
          policy: "./src/policy.ts",
        },
        {
          principal: `{ id: "${OLIVIA}", tenant: "${ACME}", memberships: [{ scope: "organization", id: "${ACME}", roles: ["owner"] }] }`,
          check: `permissions.quotes.read, { organization_id: "${ACME}" }`,
        },
      ),
    };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function countingSource(
  memberships: readonly Row[],
  version: number,
): {
  source: Row;
  calls: () => number;
  byMethod: () => Readonly<Record<string, number>>;
} {
  const counts = { membershipsFor: 0, version: 0, customRolesVersion: 0 };
  return {
    source: {
      name: "counting",
      membershipsFor: () => {
        counts.membershipsFor += 1;
        return memberships.map((membership) => ({ ...membership }));
      },
      version: () => {
        counts.version += 1;
        return version;
      },
      customRolesVersion: () => {
        counts.customRolesVersion += 1;
        return 0;
      },
    },
    calls: () =>
      counts.membershipsFor + counts.version + counts.customRolesVersion,
    byMethod: () => ({ ...counts }),
  };
}

function perCall(run: () => unknown): Stats & { readonly calls: number } {
  for (let index = 0; index < 200; index += 1) run();
  const samples: number[] = [];
  for (let index = 0; index < CALLS; index += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return { ...stats(samples), calls: CALLS };
}

async function perCallAsync(
  run: () => Promise<unknown>,
): Promise<Stats & { readonly calls: number }> {
  for (let index = 0; index < 200; index += 1) await run();
  const samples: number[] = [];
  for (let index = 0; index < CALLS; index += 1) {
    const start = performance.now();
    await run();
    samples.push(performance.now() - start);
  }
  return { ...stats(samples), calls: CALLS };
}

async function fingerprints(claims: string): Promise<Row> {
  // SAFETY: the built `permdock` entries and the policy modules export these.
  const core = (await load("permdock")) as PermDockModule;
  // SAFETY: as above.
  const bsb = (await load("permdock/better-supabase")) as BetterSupabaseModule;
  // SAFETY: as above.
  const example = (await import(
    pathToFileURL(join(EXAMPLE, "src", "policy.ts")).href
  )) as PolicyModule;
  // SAFETY: as above.
  const fixture = (await import(pathToFileURL(FIXTURE).href)) as PolicyModule;

  const fingerprint = async (
    policy: unknown,
    principal: Row,
    keys: readonly string[],
  ): Promise<Row> => {
    const memberships = principal["memberships"];
    const counting = countingSource(
      Array.isArray(memberships) ? memberships.filter(isRow) : [],
      1,
    );
    const instance = await core.getPermDock(policy, principal, {
      memberships: counting.source,
    });
    const built = counting.byMethod();
    const builtTotal = counting.calls();
    const value = bsb.grantFingerprint(instance, keys);
    const timing = perCall(() => bsb.grantFingerprint(instance, keys));
    return {
      keys: keys.length,
      shape: typeof value === "string" ? value.slice(0, 4) : value,
      ...timing,
      sourceCallsAtBuild: built,
      sourceCallsInFingerprint: counting.calls() - builtTotal,
    };
  };
  const fixtureRead = Object.keys(fixture.permissions)
    .filter((name) => name.startsWith("res"))
    .map((name) => `${name}.read`);
  const fixtureAdmin = {
    id: "u-o0",
    tenant: "o0",
    memberships: [{ scope: "tenant", id: "o0", roles: ["admin"] }],
  };

  const claimed: unknown = JSON.parse(claims);
  const claimMemberships =
    isRow(claimed) && Array.isArray(claimed["memberships"])
      ? claimed["memberships"].filter(isRow)
      : [];
  const keys = ["quotes.read", "quotes.list"];
  const shareKey = async (versions: boolean): Promise<Row> => {
    const counting = countingSource(claimMemberships, 1);
    const permdockFor = bsb.permdockFor({
      policy: example.policy,
      memberships: counting.source,
      instances: core.instanceCache(),
      ...(versions ? { versions: core.memoryVersionCache() } : {}),
    });
    const hooks = bsb.authorizationHooks({
      policy: example.policy,
      permdockFor,
    });
    const input = {
      subject: { type: "user", id: OLIVIA, properties: { claims: claimed } },
      context: { tenant: ACME },
    };
    const firstStart = performance.now();
    const first = await hooks.shareKey(undefined, keys, input);
    const firstMs = performance.now() - firstStart;
    const atFirst = counting.byMethod();
    const timing = await perCallAsync(async () => {
      await hooks.shareKey(undefined, keys, input);
    });
    return {
      wiring: `authorizationHooks({ policy, permdockFor }) over permdockFor({ policy, memberships: counting, instances: instanceCache()${versions ? ", versions: memoryVersionCache()" : ""} }), the token hook's claims for olivia in acme`,
      keys: keys.length,
      shape: typeof first === "string" ? first.slice(0, 4) : first,
      firstCallMs: round(firstMs),
      sourceCallsFirstCall: atFirst,
      ...timing,
      sourceCallsTotal: counting.byMethod(),
    };
  };
  return {
    grantFingerprint: {
      example: await fingerprint(
        example.policy,
        {
          id: OLIVIA,
          tenant: ACME,
          memberships: [{ scope: "organization", id: ACME, roles: ["owner"] }],
        },
        keys,
      ),
      fixtureOneKey: await fingerprint(fixture.policy, fixtureAdmin, [
        "res00.read",
      ]),
      fixtureAllReads: await fingerprint(
        fixture.policy,
        fixtureAdmin,
        fixtureRead,
      ),
    },
    shareKey: {
      instances: await shareKey(false),
      instancesAndVersions: await shareKey(true),
    },
  };
}

const MEMO = `
create function pg_temp.pd_token_current_memo() returns boolean
language plpgsql volatile set search_path = '' as $$
declare v text := current_setting('pdbench.token_current', true);
begin
  if v is null or v = '' then
    v := "permdock".permdock_token_current()::text;
    perform set_config('pdbench.token_current', v, true);
  end if;
  return v::boolean;
end;
$$`;

async function variantB(client: PgClient): Promise<void> {
  const definition = async (signature: string): Promise<string> =>
    stringAt(
      single(
        await client.query("select pg_get_functiondef($1::regprocedure) as d", [
          signature,
        ]),
      ).rows[0],
      "d",
    );
  const ids = (await definition("permdock.permitted_organization_ids(text)"))
    .replace(
      "FUNCTION permdock.permitted_organization_ids(",
      "FUNCTION pg_temp.permitted_organization_ids_b(",
    )
    .replaceAll(
      '"permdock".permdock_token_current()',
      "pg_temp.pd_token_current_memo()",
    );
  const byPermission = (
    await definition("permdock.permitted_organization_ids_by_permission(text)")
  )
    .replace(
      "FUNCTION permdock.permitted_organization_ids_by_permission(",
      "FUNCTION pg_temp.permitted_organization_ids_by_permission_b(",
    )
    .replaceAll(
      '"permdock".permitted_organization_ids(',
      "pg_temp.permitted_organization_ids_b(",
    );
  if (!ids.includes("pg_temp.pd_token_current_memo()")) {
    throw new Error(
      "permitted_organization_ids no longer calls permdock_token_current()",
    );
  }
  await client.query(MEMO);
  await client.query(ids);
  await client.query(byPermission);
}

function statement(call: string): string {
  return `select count(*)::int as n from ${call}`;
}

async function helpers(client: PgClient, claims: string): Promise<Row> {
  const grant = stringAt(
    single(
      await client.query(
        "select g as grant_key from permdock.grant_keys('quotes.read', 'organization') g limit 1",
      ),
    ).rows[0],
    "grant_key",
  );
  await variantB(client);
  const asUser = (sql: string): string =>
    `begin; select set_config('request.jwt.claims', ${literal(claims)}, true); set local role authenticated; ${sql}; rollback;`;
  let prepared = 0;
  const roundTrip = async (call: string): Promise<Row> => {
    prepared += 1;
    const name = `helper_${prepared}`;
    const answered = many(await client.query(asUser(statement(call))))[3]
      ?.rows[0];
    await client.query("begin");
    await client.query(
      `select set_config('request.jwt.claims', ${literal(claims)}, true)`,
    );
    await client.query("set local role authenticated");
    const times = stats(
      await timed(RUNS, async () => {
        await client.query({ name, text: statement(call), values: [] });
      }),
    );
    await client.query("rollback");
    return { call, rows: numberAt(answered, "n"), roundTrip: times };
  };
  const pair = async (
    todayCall: string,
    memoCall: string,
  ): Promise<{ today: Row; memo: Row }> => {
    const [todayServer, memoServer] = await serverTimes(
      client,
      [statement(todayCall), statement(memoCall)],
      asUser,
      3,
    );
    return {
      today: { ...(await roundTrip(todayCall)), server: todayServer },
      memo: { ...(await roundTrip(memoCall)), server: memoServer },
    };
  };
  const ids = await pair(
    `permdock.permitted_organization_ids('${grant}')`,
    `pg_temp.permitted_organization_ids_b('${grant}')`,
  );
  const byPermission = await pair(
    "permdock.permitted_organization_ids_by_permission('quotes.read')",
    "pg_temp.permitted_organization_ids_by_permission_b('quotes.read')",
  );
  const today = { ids: ids.today, byPermission: byPermission.today };
  const memo = { ids: ids.memo, byPermission: byPermission.memo };
  const cut = (before: Row, after: Row): number => {
    const mean = (row: Row): number => numberAt(row["server"], "meanMs");
    return round((mean(before) - mean(after)) / mean(before));
  };
  const cuts = {
    ids: cut(today.ids, memo.ids),
    byPermission: cut(today.byPermission, memo.byPermission),
  };
  return {
    subject:
      "olivia (owner of acme, member of globex) with the token hook's current claims, as authenticated",
    method:
      "server time is EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) Execution Time per statement in its own rolled-back transaction, today and variant B alternating; the round trip reuses one transaction",
    today,
    variantB: {
      what: "permdock_token_current() memoised per transaction in a GUC, shared by every grant key of the statement",
      ...memo,
      meanCut: cuts,
      ships:
        cuts.ids >= VARIANT_CUT && cuts.byPermission >= VARIANT_CUT
          ? "cuts the mean by a fifth or more"
          : "cuts the mean by less than a fifth",
    },
    variantC: {
      measured: false,
      reason:
        "the example's helpers join no suspension table (its config sets no suspension source), so the claims branch has no join to drop",
    },
  };
}

function machine(postgres: string): Row {
  const cpu = cpus();
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const pkg: unknown = JSON.parse(
    readFileSync(join(ROOT, "packages", "permdock", "package.json"), "utf8"),
  );
  return {
    date: new Date().toISOString().slice(0, 19) + "Z",
    node: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    cpu: `${cpu[0]?.model ?? "unknown"} (${cpu.length} cores)`,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    postgres,
    permdock: stringAt(pkg, "version"),
    commit: git.stdout.trim(),
  };
}

const { db, rest, publishable } = stack();
// SAFETY: the `pg` package's CommonJS default export is its namespace.
const pg = (await load("pg")) as PgModule;
const client = new pg.default.Client({ connectionString: db });
await client.connect();
try {
  const postgres = stringAt(
    single(await client.query("show server_version")).rows[0],
    "server_version",
  );
  const claims = await claimsOf(client, OLIVIA);
  const versions = await versionReads(client, rest, publishable);
  const helperTimes = await helpers(client, claims);
  const cold = coldInstances();
  const shared = await fingerprints(claims);
  const notRunning =
    "needs the example's Next.js app running with a signed-in session through the auth service; it was not running, and starting next dev would compile the other uncommitted work in this tree";
  const record = {
    machine: machine(postgres),
    stack:
      "apps/examples/next-better-supabase local stack, seed data (4 users, 2 organizations)",
    versionRead: versions,
    coldInstance: { thresholdMs: COLD_THRESHOLD_MS, ...cold },
    ...shared,
    helpers: helperTimes,
    serverAction: { measured: false, reason: notRunning },
    sharedEntry: { measured: false, reason: notRunning },
  };
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
} finally {
  await client.end();
}
