import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Query } from "./centrakit-read-only-actors.ts";

import { measureReadOnlyActors } from "./centrakit-read-only-actors.ts";

/**
 * The database half of the CentraKit dry run: starts the Supabase stack of the
 * copy, loads its declarative schema files with `supabase db schema declarative
 * sync`, runs `permdock rls verify --shadow` and better-supabase's doctor
 * BS409, BS428, BS429 and BS430 against it, and reports each of the `tenant`
 * tables of `rls.tableReads` against BS428.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE = "supabase@3.4.0";
/** Services the dry run does not read. */
const EXCLUDED = "functions,studio,mail,analytics,pooler";
const CODES = ["BS409", "BS428", "BS429", "BS430"] as const;
const TEMPLATE = "permdock.permitted_{scope}_ids_by_permission({permission})";
const BUFFER = 256 * 1024 * 1024;

type Json = Readonly<Record<string, unknown>>;
type Row = { readonly table: string; readonly using: string };
type Client = {
  readonly connect: () => Promise<void>;
  readonly end: () => Promise<void>;
  readonly query: (sql: string) => Promise<{ readonly rows: readonly Row[] }>;
};
type Spawned = { readonly status: number | null; readonly stdout: string };
type Input = {
  readonly root: string;
  readonly identity: string;
  readonly permdockBin: string;
  readonly betterSupabaseBin: string;
};

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const escaped = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

/** `npx supabase@3.4.0` from the temp directory: the repository pins pnpm. */
function cli(args: readonly string[], workdir: string): string {
  const result = spawnSync(
    "npx",
    ["--yes", SUPABASE, ...args, "--workdir", workdir],
    { cwd: tmpdir(), encoding: "utf8", maxBuffer: BUFFER },
  );
  if (result.status !== 0) {
    throw new Error(
      `supabase ${args.join(" ")}: ${result.stderr.slice(-2000)}`,
    );
  }
  return result.stdout;
}

function dbUrlOf(output: string): string {
  const last = output
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("{"));
  const parsed: unknown = last === undefined ? undefined : JSON.parse(last);
  const env = isRecord(parsed) ? parsed["env"] : undefined;
  const url = isRecord(env) ? env["DB_URL"] : undefined;
  if (typeof url !== "string") {
    throw new TypeError("supabase start printed no DB_URL");
  }
  return url;
}

function json(stdout: string): unknown {
  try {
    const parsed: unknown = JSON.parse(stdout.slice(stdout.indexOf("{")));
    return isRecord(parsed) && "data" in parsed ? parsed["data"] : parsed;
  } catch {
    return stdout.slice(-2000);
  }
}

/** The keys a policy body passes to the provider's by-permission helper. */
function checkedKeys(using: string): ReadonlySet<string> {
  const source = TEMPLATE.split(/(\{\w+\})/u)
    .map((part) => {
      if (part === "{permission}") return String.raw`'((?:[^']|'')*)'`;
      if (part === "{scope}") return "[a-z][a-z0-9_]*";
      return escaped(part.trim()).replaceAll(/\s+/gu, String.raw`\s*`);
    })
    .filter((part) => part !== "")
    .join(String.raw`\s*`);
  const keys = new Set<string>();
  for (const match of using.matchAll(new RegExp(source, "giu"))) {
    if (match[1] !== undefined) keys.add(match[1]);
  }
  return keys;
}

/** The permissive select policies `pg_policies` holds, by qualified table. */
async function selectPolicies(url: string): Promise<readonly Row[]> {
  // SAFETY: `pg` is a dependency of tests/integration, which this script borrows; `Client` is the part of its API used here.
  const { Client: Connection } = createRequire(
    join(ROOT, "tests", "integration", "package.json"),
  )("pg") as {
    readonly Client: new (config: {
      readonly connectionString: string;
    }) => Client;
  };
  const client = new Connection({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select schemaname || '.' || tablename as "table", coalesce(qual, '') as using
       from pg_policies
       where permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL') and 'authenticated' = any(roles::text[])`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

function listOf(value: unknown): readonly Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function tenantTablesOf(identity: string): readonly Json[] {
  const manifest: unknown = JSON.parse(
    readFileSync(join(identity, "permdock.manifest.json"), "utf8"),
  );
  const rls = isRecord(manifest) ? manifest["rls"] : undefined;
  return listOf(isRecord(rls) ? rls["tableReads"] : undefined).filter(
    (read) => read["share"] === "tenant",
  );
}

function spawn(
  bin: string,
  args: readonly string[],
  cwd: string,
  url: string,
): Spawned {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, NO_COLOR: "1" },
    maxBuffer: BUFFER,
  });
  return { status: result.status, stdout: result.stdout };
}

/** BS428 findings by table, from the doctor report. */
function failingBS428(findings: readonly Json[]): ReadonlyMap<string, string> {
  return new Map(
    findings
      .filter((finding) => finding["code"] === "BS428")
      .map((finding) => [
        String(finding["target"]).replace(/^authorization\.tables\./u, ""),
        String(finding["message"]),
      ]),
  );
}

/**
 * Whether a table's select policies check exactly its listed keys once `::text`
 * is removed.
 */
function matchesWithoutCast(
  read: Json,
  policies: readonly Row[],
): { readonly table: string; readonly ok: boolean } {
  const table = String(read["table"]);
  const keys = new Set(
    policies
      .filter((row) => row.table === table)
      .flatMap((row) => [...checkedKeys(row.using.replaceAll("::text", ""))]),
  );
  const listed = new Set(
    Array.isArray(read["permissions"]) ? read["permissions"].map(String) : [],
  );
  return {
    table,
    ok: keys.size === listed.size && [...keys].every((key) => listed.has(key)),
  };
}

function doctorSection(
  findings: readonly Json[],
  tenant: readonly Json[],
): Json {
  const failing = failingBS428(findings);
  const failingTenant = tenant
    .map((read) => String(read["table"]))
    .filter((table) => failing.has(table));
  return {
    counts: Object.fromEntries(
      CODES.map((code) => [
        code,
        findings.filter((finding) => finding["code"] === code).length,
      ]),
    ),
    tenantTables: {
      total: tenant.length,
      failingBS428: failingTenant.map((table) => ({
        table,
        message: failing.get(table),
      })),
    },
    otherBS428: failing.size - failingTenant.length,
  };
}

const HELPER_CALLS = 2_000;

function quotedCall(schema: string, name: string, args: string): string {
  return `"${schema}"."${name}"(${args})`;
}

async function statementMicros(query: Query, call: string): Promise<number> {
  await query(`select ${call}`);
  const started = performance.now();
  await query(
    `select ${call} from generate_series(1, ${String(HELPER_CALLS)})`,
  );
  return Math.round(((performance.now() - started) / HELPER_CALLS) * 1000);
}

async function innerArguments(
  query: Query,
  schema: string,
  name: string,
  wanted: string,
): Promise<string> {
  const { rows } = await query(
    `select pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = '${schema}' and p.proname = '${name}'
       and pg_get_function_identity_arguments(p.oid) like '${wanted}'
     limit 1`,
  );
  return String(rows[0]?.["args"]);
}

/**
 * Statement time of one active-tenant wrapper against the two-argument helper
 * it calls. `language sql` is inlined, so `pg_stat_statements` records the
 * statement, which is what `permdock rls measure` reads. The stack has no rows
 * and no token, so both calls answer false; the difference is the wrapper.
 */
async function activeHelpers(query: Query): Promise<Json> {
  const { rows } = await query(
    `select n.nspname as schema, p.proname as name,
       pg_get_function_identity_arguments(p.oid) as args
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'permdock'
       and (p.proname like '%\\_has\\_active' or p.proname like '%\\_permission\\_keys\\_active')
     order by p.proname`,
  );
  const timed = [];
  /* oxlint-disable no-await-in-loop -- the timings share one database */
  for (const row of rows) {
    const schema = String(row["schema"]);
    const name = String(row["name"]);
    const args = String(row["args"]);
    const keys = args.includes("text[]");
    const wrapper = quotedCall(schema, name, keys ? "array['x']" : "'x'");
    const innerArgs = await innerArguments(
      query,
      schema,
      name.replace(/_active$/u, ""),
      keys ? "%text[]%" : "%,%",
    );
    const tenant = innerArgs.includes("uuid")
      ? "'00000000-0000-4000-8000-0000000000b1'::uuid"
      : "'acme'";
    const inner = quotedCall(
      schema,
      name.replace(/_active$/u, ""),
      keys ? `${tenant}, array['x']` : `'x', ${tenant}`,
    );
    timed.push({
      name: `${schema}.${name}`,
      // Sequential: the two timings share one database, so they must not overlap.
      wrapperMicros: await statementMicros(query, wrapper),
      innerMicros: await statementMicros(query, inner),
      calls: HELPER_CALLS,
    });
  }
  /* oxlint-enable no-await-in-loop */
  return { calls: HELPER_CALLS, functions: timed };
}

/** One connection to `url`. */
async function withQuery<T>(
  url: string,
  run: (query: Query) => Promise<T>,
): Promise<T> {
  // SAFETY: `pg` is a dependency of tests/integration, which this script borrows; `Client` is the part of its API used here.
  const { Client: Connection } = createRequire(
    join(ROOT, "tests", "integration", "package.json"),
  )("pg") as {
    readonly Client: new (config: { readonly connectionString: string }) => {
      readonly connect: () => Promise<void>;
      readonly end: () => Promise<void>;
      readonly query: Query;
    };
  };
  const client = new Connection({ connectionString: url });
  await client.connect();
  try {
    return await run(async (sql) => {
      const { rows } = await client.query(sql);
      return { rows };
    });
  } finally {
    await client.end();
  }
}

/** One connection to `url` for the read-only actor measurement. */
async function readOnlyActors(url: string): Promise<Json> {
  // SAFETY: `pg` is a dependency of tests/integration, which this script borrows; `Client` is the part of its API used here.
  const { Client: Connection } = createRequire(
    join(ROOT, "tests", "integration", "package.json"),
  )("pg") as {
    readonly Client: new (config: { readonly connectionString: string }) => {
      readonly connect: () => Promise<void>;
      readonly end: () => Promise<void>;
      readonly query: Query;
    };
  };
  const client = new Connection({ connectionString: url });
  await client.connect();
  try {
    return await measureReadOnlyActors(async (sql) => {
      const { rows } = await client.query(sql);
      return { rows };
    });
  } finally {
    await client.end();
  }
}

async function report(input: Input, url: string): Promise<Json> {
  const started = performance.now();
  const verify = spawn(
    input.permdockBin,
    ["rls", "verify", "--shadow", "stack", "--json", "--yes", "--agent", "no"],
    input.identity,
    url,
  );
  const verifyMs = Math.round(performance.now() - started);
  const only = CODES.join(",");
  const doctor = spawn(
    input.betterSupabaseBin,
    ["doctor", "--json", "--only", only, "--fail-on", "never", "--agent", "no"],
    input.root,
    url,
  );
  const body = json(doctor.stdout);
  const tenant = tenantTablesOf(input.identity);
  const policies = await selectPolicies(url);
  const checked = tenant.map((read) => matchesWithoutCast(read, policies));
  return {
    shadow: { code: verify.status, ms: verifyMs, report: json(verify.stdout) },
    readOnlyActors: await readOnlyActors(url),
    activeHelpers: await withQuery(url, activeHelpers),
    doctor: doctorSection(
      listOf(isRecord(body) ? body["findings"] : undefined),
      tenant,
    ),
    tenantTablesWithTheCastRemoved: {
      total: checked.length,
      passing: checked.filter((entry) => entry.ok).length,
      failing: checked.filter((entry) => !entry.ok).map((entry) => entry.table),
    },
  };
}

/**
 * Starts the stack of `root`, loads its schema files, runs the doctors, stops
 * the stack and returns the report.
 */
export async function runStack(input: Input): Promise<Json> {
  const url = dbUrlOf(cli(["start", "-x", EXCLUDED], input.root));
  try {
    cli(["db", "schema", "declarative", "sync", "--yes"], input.root);
    return await report(input, url);
  } finally {
    try {
      cli(["stop"], input.root);
    } catch {
      // The stack is the script's own; a failed stop leaves a container to remove by hand.
    }
  }
}
