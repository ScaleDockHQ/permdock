/* oxlint-disable max-lines-per-function, no-await-in-loop -- a measurement driver: each timed run waits for the one before it */
/* oxlint-disable require-await -- the fake runtime cache implements an async interface over a Map */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Measures the 0.31 request costs against
 * `tests/integration/fixtures/centrakit` and writes
 * `scripts/centrakit-latency.json`: `node scripts/centrakit-latency.ts` after
 * `pnpm build`. No database runs. A version read waits for the PostgREST round
 * trip that `scripts/authz-latency.json` measured on this machine
 * (`versionRead.postgrestRpcFloor`), so the call counts are exact and the
 * milliseconds are that latency times the calls plus the work in process.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "tests", "integration", "fixtures", "centrakit");
const OUT = join(ROOT, "scripts", "centrakit-latency.json");
const LATENCY = join(ROOT, "scripts", "authz-latency.json");
const fromIntegration = createRequire(
  join(ROOT, "tests", "integration", "package.json"),
);

const COLD_RUNS = 30;
const ACTIONS = 200;
const FINGERPRINTS = 10_000;
const ORG = "00000000-0000-4000-8000-0000000000b1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2";

type Row = Readonly<Record<string, unknown>>;
type Stats = {
  readonly runs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
};
type Instance = {
  readonly can: (permission: unknown, row?: unknown) => boolean;
};
type Entry = { readonly version: number; readonly at: number };
type Store = {
  readonly get: (id: string) => Promise<Entry | undefined>;
  readonly set: (id: string, version: number, at: number) => Promise<void>;
  readonly delete: (id: string) => Promise<void>;
};
type VersionCache = {
  readonly current: (
    principal: Row,
    read: () => Promise<number>,
    options: { readonly live: boolean },
  ) => Promise<number>;
};
type Core = {
  readonly memoryVersionCache: (options?: Row) => VersionCache;
  readonly instanceCache: () => unknown;
  readonly runtimeCacheVersionStore: (cache: Row) => Store;
};
type Bsb = {
  readonly grantFingerprint: (
    instance: Instance,
    keys: readonly string[],
  ) => unknown;
  readonly permdockFor: (
    options: Row,
  ) => (source: Row, query: Row, versions?: VersionCache) => Promise<Instance>;
  readonly authorizationHooks: (options: Row) => {
    readonly shareKey: (
      authorizer: undefined,
      keys: readonly string[],
      input: Row,
    ) => Promise<unknown>;
  };
};
type PolicyModule = {
  readonly policy: unknown;
  readonly permissions: Readonly<Record<string, Row>>;
};

const round = (value: number): number => Math.round(value * 1000) / 1000;

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

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function numberAt(record: unknown, path: readonly string[]): number {
  let node: unknown = record;
  for (const key of path) node = isRow(node) ? node[key] : undefined;
  if (typeof node !== "number") throw new TypeError(path.join("."));
  return node;
}

async function load(specifier: string): Promise<unknown> {
  // Dynamic: the built package resolves only from a workspace that depends on it.
  const module: unknown = await import(
    pathToFileURL(fromIntegration.resolve(specifier)).href
  );
  return module;
}

function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* waits for the simulated round trip */
  }
}

/** A version read: the round trip, counted. */
function versionSource(latencyMs: number): {
  readonly source: Row;
  readonly read: () => number;
  readonly reads: () => number;
} {
  let reads = 0;
  const read = (): number => {
    reads += 1;
    spin(latencyMs);
    return 1;
  };
  return {
    source: { name: "counting", membershipsFor: () => [], version: read },
    read,
    reads: () => reads,
  };
}

const claimsOf = (user: string, org: string): Row => ({
  sub: user,
  role: "authenticated",
  tenant_id: org,
  authz_ver: 1,
  memberships: [{ scope: "organization", id: org, roles: ["admin"] }],
});

/** One fresh `node` process per sample; the marks are `performance.now()`. */
function child(code: string): Row {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: FIXTURE_DIR,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`child failed:\n${run.stderr}`);
  const parsed: unknown = JSON.parse(run.stdout);
  if (!isRow(parsed)) throw new TypeError("child printed no object");
  return parsed;
}

const PRINCIPAL = `{ id: "u1", tenant: "${ORG}", memberships: [{ scope: "organization", id: "${ORG}", roles: ["admin"] }] }`;

const firstRequestCode = (warmed: boolean): string => `
const m = {};
const pd = await import("permdock");
const bsb = await import("permdock/better-supabase");
const { policy, permissions } = await import("./policy.ts");
${warmed ? "m.warm = (await bsb.authorizationHooks({ policy }).warm()).ms;" : ""}
const start = performance.now();
const instance = await pd.getPermDock(policy, ${PRINCIPAL});
instance.can(permissions.quotes.read, { id: "q", organization_id: "${ORG}", customer_id: "${ORG}" });
m.firstRequest = performance.now() - start;
process.stdout.write(JSON.stringify(m));`;

const sample = (warmed: boolean): readonly Row[] =>
  Array.from({ length: COLD_RUNS }, () => child(firstRequestCode(warmed)));

/** The first request of a process, with and without `warm()` before it. */
function firstRequest(): Row {
  const column = (rows: readonly Row[], key: string): readonly number[] =>
    rows.map((row) => numberAt(row, [key]));
  const cold = sample(false);
  const warmed = sample(true);
  return {
    wiring:
      "getPermDock for an admin plus one can, in a fresh process after the policy is imported; warmed runs authorizationHooks({ policy }).warm() first",
    withoutWarm: stats(column(cold, "firstRequest")),
    withWarm: stats(column(warmed, "firstRequest")),
    warmCost: stats(column(warmed, "warm")),
  };
}

/** The cold instance: policy import to the first `can`, five marks. */
function coldInstance(): Row {
  const code = `
const m = { start: performance.now() };
const pd = await import("permdock");
m.permdock = performance.now();
const { policy, permissions } = await import("./policy.ts");
m.policy = performance.now();
const instance = await pd.getPermDock(policy, ${PRINCIPAL});
m.getPermDock = performance.now();
instance.can(permissions.quotes.read, { id: "q", organization_id: "${ORG}", customer_id: "${ORG}" });
m.can = performance.now();
process.stdout.write(JSON.stringify(m));`;
  const rows = Array.from({ length: COLD_RUNS }, () => child(code));
  const span = (from: string, to: string): Stats =>
    stats(rows.map((row) => numberAt(row, [to]) - numberAt(row, [from])));
  return {
    policy: "tests/integration/fixtures/centrakit/policy.ts: 8 keys, 6 roles",
    policyModule: span("permdock", "policy"),
    getPermDock: span("policy", "getPermDock"),
    firstCan: span("getPermDock", "can"),
    policyToFirstCan: span("permdock", "can"),
  };
}

/**
 * A Server Action that checks `quotes.read`, `quotes.update` and
 * `quotes.update` again. Before, the update asks for intent `write` and reads
 * the version live each time; after, `database-write` takes it from the cache.
 */
async function serverAction(
  core: Core,
  bsb: Bsb,
  policy: unknown,
  permissions: PolicyModule["permissions"],
  latencyMs: number,
): Promise<Row> {
  const quote = { id: "q", organization_id: ORG, customer_id: ORG };
  const run = async (writeIntent: string): Promise<Row> => {
    const db = versionSource(latencyMs);
    const resolve = bsb.permdockFor({
      policy,
      memberships: db.source,
      instances: core.instanceCache(),
    });
    const versions = core.memoryVersionCache();
    const action = async (): Promise<void> => {
      const claims = { kind: "user", claims: claimsOf("u1", ORG) };
      const read = await resolve(
        claims,
        { tenant: ORG, intent: "read" },
        versions,
      );
      read.can(permissions["quotes"]?.["read"], quote);
      for (let write = 0; write < 2; write += 1) {
        const instance = await resolve(
          claims,
          { tenant: ORG, intent: writeIntent },
          versions,
        );
        instance.can(permissions["quotes"]?.["update"], quote);
      }
    };
    const first = performance.now();
    await action();
    const firstMs = performance.now() - first;
    const firstReads = db.reads();
    const samples: number[] = [];
    for (let index = 0; index < ACTIONS; index += 1) {
      const start = performance.now();
      await action();
      samples.push(performance.now() - start);
    }
    return {
      versionReadsFirstAction: firstReads,
      versionReadsPerLaterAction: round((db.reads() - firstReads) / ACTIONS),
      firstActionMs: round(firstMs),
      laterActions: stats(samples),
    };
  };
  return {
    checks: "quotes.read, then quotes.update twice, through permdockFor",
    versionReadMs: latencyMs,
    before: await run("write"),
    after: await run("database-write"),
  };
}

/** Two members with equal grants share one fill; the fingerprint is the key. */
async function sharedEntry(
  core: Core,
  bsb: Bsb,
  policy: unknown,
  keys: readonly string[],
): Promise<Row> {
  const hooks = bsb.authorizationHooks({
    policy,
    permdockFor: bsb.permdockFor({
      policy,
      memberships: { name: "none", membershipsFor: () => [] },
      instances: core.instanceCache(),
    }),
  });
  const keyOf = async (user: string, org: string): Promise<unknown> => {
    const key = await hooks.shareKey(undefined, keys, {
      subject: {
        type: "user",
        id: user,
        properties: { claims: claimsOf(user, org) },
      },
      context: { tenant: org },
    });
    return key;
  };
  const [first, second, other] = [
    await keyOf("u1", ORG),
    await keyOf("u2", ORG),
    await keyOf("u3", OTHER_ORG),
  ];
  const fills = new Map<unknown, number>();
  for (const key of [first, second]) fills.set(key, (fills.get(key) ?? 0) + 1);
  const samples: number[] = [];
  for (let index = 0; index < FINGERPRINTS; index += 1) {
    const start = performance.now();
    await keyOf("u1", ORG);
    samples.push(performance.now() - start);
  }
  return {
    keys: keys.length,
    equalForEqualGrants: first === second,
    equalAcrossTenants: first === other,
    fillsForTwoMembersShared: fills.size,
    fillsForTwoMembersPerUser: 2,
    shareKeyOnePage: stats(samples),
    note: "The fingerprint covers grants, not the tenant id: admins of two organisations share it, so a bsb.kept key adds the tenant when the data differs by tenant",
  };
}

/** The first request of a process with and without a shared version store. */
async function runtimeStore(core: Core, latencyMs: number): Promise<Row> {
  const data = new Map<string, unknown>();
  const cache: Row = {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
  };
  const principal: Row = { id: "u1" };
  const readFirst = async (shared: boolean): Promise<Row> => {
    const db = versionSource(latencyMs);
    const versions = core.memoryVersionCache(
      shared ? { shared: core.runtimeCacheVersionStore(cache) } : {},
    );
    const start = performance.now();
    await versions.current(principal, async () => db.read(), { live: false });
    return { versionReads: db.reads(), ms: round(performance.now() - start) };
  };
  const without = await readFirst(false);
  const fill = await readFirst(true);
  const second = await readFirst(true);
  return {
    versionReadMs: latencyMs,
    withoutStore: without,
    storeEmpty: fill,
    storeFilledByAnotherInstance: second,
  };
}

function machine(): Row {
  const cpu = cpus();
  const git = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    date: `${new Date().toISOString().slice(0, 19)}Z`,
    node: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    cpu: `${cpu[0]?.model ?? "unknown"} (${cpu.length} cores)`,
    commit: git.stdout.trim(),
  };
}

// SAFETY: the built `permdock` entries export these.
const core = (await load("permdock")) as Core;
// SAFETY: as above.
const bsb = (await load("permdock/better-supabase")) as Bsb;
// SAFETY: the fixture exports `policy` and `permissions`.
const fixture = (await import(
  pathToFileURL(join(FIXTURE_DIR, "policy.ts")).href
)) as PolicyModule;
const latency = numberAt(JSON.parse(readFileSync(LATENCY, "utf8")), [
  "versionRead",
  "postgrestRpcFloor",
  "meanMs",
]);
const keys = ["quotes.read", "quotes.update", "customers.read"];

const record = {
  machine: machine(),
  stack: "tests/integration/fixtures/centrakit, no database",
  versionReadMs: latency,
  coldInstance: coldInstance(),
  firstRequest: firstRequest(),
  serverAction: await serverAction(
    core,
    bsb,
    fixture.policy,
    fixture.permissions,
    latency,
  ),
  sharedEntry: await sharedEntry(core, bsb, fixture.policy, keys),
  runtimeCacheVersionStore: await runtimeStore(core, latency),
};
writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
