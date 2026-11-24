import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The database half of the CentraKit dry run: starts the Supabase stack of the
 * copy, loads its declarative schema files with `supabase db schema declarative
 * sync`, runs `permdock rls verify --shadow` and better-supabase's doctor
 * BS409, BS428, BS429 and BS430 against it, and reports each of the `tenant`
 * tables of `rls.tableReads` against BS428.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE = "supabase@3.3.0";
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

/** `npx supabase@3.3.0` from the temp directory: the repository pins pnpm. */
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

async function report(input: Input, url: string): Promise<Json> {
  const verify = spawn(
    input.permdockBin,
    ["rls", "verify", "--shadow", "stack", "--json", "--yes", "--agent", "no"],
    input.identity,
    url,
  );
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
    shadow: { code: verify.status, report: json(verify.stdout) },
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
