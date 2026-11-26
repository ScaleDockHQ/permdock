import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { runStack } from "./centrakit-stack.ts";

/**
 * The 0.31 acceptance dry run: `node scripts/centrakit-dry-run.ts [--shadow
 * <url|stack>] [--stack] [--centrakit <dir>] [--keep]`. It copies
 * `../CentraKit` to a temp directory, never writing to the original, and links
 * the copy's `permdock` and `better-supabase` to this checkout's build and
 * installed copy. `BSB_CHECKOUT` points `better-supabase` at another build,
 * which is how a check runs against a newer doctor than the catalog pin. It
 * runs `codemod 0.31`, `codemod config --prune`, `codemod bsb-access-tags` and
 * `codemod bsb-action-keys` on the copy and writes
 * `scripts/centrakit-dry-run.json`: config lines per section, the generated SQL
 * diff, `rls report` totals, `rls.tableReads` counts per rule with the table
 * list and the reason of each `form` table, PD128 and better-supabase BS409,
 * BS428 and BS429, each before and after. `--stack` starts the copy's Supabase
 * stack, loads its schema files and adds `rls verify --shadow` and the doctors
 * BS409, BS428, BS429 and BS430 against it (`scripts/centrakit-stack.ts`).
 * Build `permdock` first. Without CentraKit it reads
 * `tests/integration/fixtures/centrakit` and says so in `source`.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(ROOT, "packages", "permdock");
const BIN = join(PACKAGE, "dist", "cli", "bin.js");
const BSB = realpathSync(
  // oxlint-disable-next-line turbo/no-undeclared-env-vars -- a maintainer script, not a Turbo task
  process.env["BSB_CHECKOUT"] ??
    join(PACKAGE, "node_modules", "better-supabase"),
);
const OUT = join(ROOT, "scripts", "centrakit-dry-run.json");
const FIXTURE = join(ROOT, "tests", "integration", "fixtures", "centrakit");
const IDENTITY = join("packages", "identity");
const GENERATED_SQL = join("supabase", "schemas", "identity", "permdock");
const CODEMODS = [
  ["codemod", "0.31"],
  ["codemod", "config", "--prune"],
  ["codemod", "bsb-access-tags"],
  ["codemod", "bsb-action-keys"],
] as const;
/** Build output, caches and history the dry run never reads. */
const SKIP = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  ".cache",
  ".vite",
  ".vite-temp",
  ".vitest-cache",
  "coverage",
  "dist",
  "competitors",
  "plans",
]);
const OVERRIDES: Readonly<Record<string, string>> = {
  permdock: PACKAGE,
  "better-supabase": BSB,
};

const { values } = parseArgs({
  options: {
    centrakit: { type: "string" },
    shadow: { type: "string" },
    stack: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});

type Step = {
  readonly command: string;
  readonly code: number | null;
  /** A doctor exits 1 on findings, which the dry run reports instead. */
  readonly findings?: true;
  readonly stderr?: string;
};
type Json = Readonly<Record<string, unknown>>;

const steps: Step[] = [];

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function run(
  bin: string,
  args: readonly string[],
  cwd: string,
  reportsFindings = false,
): { readonly code: number | null; readonly data: unknown } {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 256 * 1024 * 1024,
  });
  const label = `${basename(bin) === "bin.js" ? "permdock" : "better-supabase"} ${args.join(" ")}`;
  steps.push({
    command: label,
    code: result.status,
    ...(reportsFindings ? { findings: true } : {}),
    ...(result.status === 0 ? {} : { stderr: result.stderr.slice(-2000) }),
  });
  let data: unknown = null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    data = isRecord(parsed) && "data" in parsed ? parsed["data"] : parsed;
  } catch {
    data = result.stdout.slice(-2000);
  }
  return { code: result.status, data };
}

function permdock(
  args: readonly string[],
  cwd: string,
  reportsFindings = false,
): ReturnType<typeof run> {
  // Agent mode asks for an effects digest; the copy is the script's own.
  return run(BIN, [...args, "--yes", "--agent", "no"], cwd, reportsFindings);
}

/** Copies the repository with every symlink kept as written. */
function copy(from: string, to: string): void {
  const linked: string[] = [];
  cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const name = basename(src);
      if (SKIP.has(name) || name.startsWith(".env")) return false;
      // Nested app installs are not what the schema dry run reads, and copying
      // them makes the temp tree tens of gigabytes. The root install is linked
      // below, with permdock and better-supabase pointed at this checkout.
      if (name === "node_modules") return false;
      if (basename(dirname(src)) === "node_modules" && name in OVERRIDES) {
        linked.push(join(to, relative(from, src)));
        return false;
      }
      return true;
    },
  });
  const modules = join(to, "node_modules");
  mkdirSync(modules);
  for (const entry of readdirSync(join(from, "node_modules"))) {
    if (entry in OVERRIDES) continue;
    symlinkSync(join(from, "node_modules", entry), join(modules, entry));
  }
  for (const [name, target] of Object.entries(OVERRIDES)) {
    symlinkSync(target, join(modules, name));
  }
  for (const path of linked) {
    const target = OVERRIDES[basename(path)];
    if (target !== undefined) symlinkSync(target, path);
  }
}

/** Lines per top-level `defineConfig` key, and per `rls` key as `rls.<key>`. */
function sections(file: string): Readonly<Record<string, number>> {
  const lines = readFileSync(file, "utf8").replace(/\n$/u, "").split("\n");
  const counts: Record<string, number> = { total: lines.length };
  let top: string | undefined;
  let nested: string | undefined;
  for (const line of lines) {
    const key = /^ {2}(\w+):/u.exec(line)?.[1];
    if (key !== undefined) {
      top = key;
      nested = undefined;
    }
    const child = /^ {4}(\w+):/u.exec(line)?.[1];
    if (top === "rls" && child !== undefined) nested = `rls.${child}`;
    if (/^\S/u.test(line)) top = undefined;
    if (top !== undefined) counts[top] = (counts[top] ?? 0) + 1;
    if (top === "rls" && nested !== undefined) {
      counts[nested] = (counts[nested] ?? 0) + 1;
    }
  }
  return counts;
}

function readSql(dir: string): Readonly<Record<string, string>> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}

/** Lines added and removed per file, as a multiset of lines. */
function diff(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): Readonly<Record<string, { added: number; removed: number }>> {
  const out: Record<string, { added: number; removed: number }> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = (before[name] ?? "").split("\n");
    const right = (after[name] ?? "").split("\n");
    const pool = new Map<string, number>();
    for (const line of left) pool.set(line, (pool.get(line) ?? 0) + 1);
    let added = 0;
    for (const line of right) {
      const unmatched = pool.get(line) ?? 0;
      if (unmatched > 0) pool.set(line, unmatched - 1);
      else added += 1;
    }
    const removed = [...pool.values()].reduce((sum, n) => sum + n, 0);
    if (added + removed > 0) out[name] = { added, removed };
  }
  return out;
}

function reportTotals(cwd: string): Json {
  const { data } = permdock(["rls", "report", "--json"], cwd);
  if (!isRecord(data) || !Array.isArray(data["tables"])) return {};
  return { tables: data["tables"].length, totals: data["totals"] };
}

const RULES = [
  "form",
  "follows",
  "via",
  "walk",
  "owner",
  "condition",
  "restrictive",
  "fields",
  "unknown",
] as const;

/**
 * `rls.tableReads` of the inspected manifest: counts per share and per rule (a
 * table that breaks two rules counts under both), the `tenant` tables by name
 * and every `row` table with its rules, its reason and the keys that widen it.
 */
function tableReads(cwd: string): Json {
  const inspected = permdock(["supabase", "inspect", "--out", "--json"], cwd);
  if (inspected.code !== 0) return {};
  const manifest: unknown = JSON.parse(
    readFileSync(join(cwd, "permdock.manifest.json"), "utf8"),
  );
  const rls = isRecord(manifest) ? manifest["rls"] : undefined;
  const reads = (
    isRecord(rls) && Array.isArray(rls["tableReads"]) ? rls["tableReads"] : []
  ).filter(isRecord);
  const rows = reads.filter((read) => read["share"] === "row");
  const rules = (read: Json): readonly unknown[] =>
    Array.isArray(read["rules"]) ? read["rules"] : [];
  return {
    tenant: reads.length - rows.length,
    row: rows.length,
    byRule: Object.fromEntries(
      RULES.map((rule) => [
        rule,
        rows.filter((read) => rules(read).includes(rule)).length,
      ]),
    ),
    rowWithoutReason: rows.filter((read) => read["reason"] === undefined)
      .length,
    /** `form` tables nothing blocks: `codemod bsb-access-tags` moves them. */
    couldShareByCodemod: rows.filter(
      (read) =>
        typeof read["reason"] === "string" &&
        read["reason"].includes("is movable"),
    ).length,
    /** `row` tables a holder of a widening key reads whole (`tenantFor`). */
    couldShareByKey: rows.filter(
      (read) =>
        Array.isArray(read["tenantFor"]) && read["tenantFor"].length > 0,
    ).length,
    tenantTables: reads
      .filter((read) => read["share"] === "tenant")
      .map((read) => read["table"]),
    tables: rows.map((read) => ({
      table: read["table"],
      rules: read["rules"],
      ...(Array.isArray(read["tenantFor"])
        ? { tenantFor: read["tenantFor"] }
        : {}),
      ...(read["reason"] === undefined ? {} : { reason: read["reason"] }),
    })),
  };
}

const PAYLOAD_PATTERN = "public.*_payload";

/**
 * `inspect --functions public.*_payload` on the copy: each page payload
 * function with a pass or every reason it is not shared.
 */
function payloadFunctions(cwd: string): Json {
  const { data } = permdock(
    ["supabase", "inspect", "--functions", PAYLOAD_PATTERN, "--json"],
    cwd,
  );
  if (!isRecord(data) || !Array.isArray(data["functions"])) return {};
  return {
    pattern: PAYLOAD_PATTERN,
    count: data["functions"].length,
    passed: data["passed"],
    functions: data["functions"],
  };
}

function findings(data: unknown, codes: readonly string[]): Json {
  const list =
    isRecord(data) && Array.isArray(data["findings"]) ? data["findings"] : [];
  const out: Record<string, unknown[]> = {};
  for (const code of codes) out[code] = [];
  for (const finding of list) {
    if (!isRecord(finding)) continue;
    const code = String(finding["code"]);
    out[code]?.push(finding["target"] ?? finding["message"]);
  }
  return out;
}

type Measure = {
  readonly config: Readonly<Record<string, number>>;
  readonly report: Json;
  readonly tableReads: Json;
  readonly pd128: Json;
  readonly betterSupabase: Json;
};

function measure(root: string, identity: string): Measure {
  return {
    config: sections(join(identity, "permdock.config.ts")),
    report: reportTotals(identity),
    tableReads: tableReads(identity),
    pd128: findings(
      permdock(["doctor", "--json", "--only", "PD128"], identity, true).data,
      ["PD128"],
    ),
    betterSupabase: findings(
      run(
        join(BSB, "bin", "better-supabase.js"),
        [
          "doctor",
          "--json",
          "--only",
          "BS409,BS428,BS429",
          "--fail-on",
          "never",
          "--agent",
          "no",
        ],
        root,
        true,
      ).data,
      ["BS409", "BS428", "BS429"],
    ),
  };
}

function fixtureOnly(source: string): void {
  const config = sections(join(FIXTURE, "permdock.config.ts"));
  writeFileSync(
    OUT,
    `${JSON.stringify({ source: "fixture", fixture: relative(ROOT, FIXTURE), config }, null, 2)}\n`,
  );
  process.stdout.write(
    `CentraKit not found at ${source}: read the fixture only. See ${relative(ROOT, OUT)}\n`,
  );
  process.exitCode = 1;
}

/** `tables: true` and `sharedFunctions: true`, the 0.31 provider options. */
function enableProviderOptions(root: string): void {
  const file = join(root, "better-supabase.config.ts");
  const text = readFileSync(file, "utf8");
  if (text.includes("sharedFunctions: true")) return;
  writeFileSync(
    file,
    text.replace(
      "authorizationProvider({",
      "authorizationProvider({\n      tables: true,\n      sharedFunctions: true,",
    ),
  );
}

/** `shadow` and `stack` of the result: the database half, when asked for. */
async function databaseReport(
  root: string,
  identity: string,
): Promise<{ readonly shadow: unknown; readonly stack: unknown }> {
  if (values.stack) {
    return {
      shadow: "see stack.shadow",
      stack: await runStack({
        root,
        identity,
        permdockBin: BIN,
        betterSupabaseBin: join(BSB, "bin", "better-supabase.js"),
      }),
    };
  }
  return {
    shadow:
      values.shadow === undefined
        ? "not run: pass --shadow <url|stack> with a Supabase stack running"
        : permdock(
            ["rls", "verify", "--shadow", values.shadow, "--json"],
            identity,
          ).code,
    stack: "not run: pass --stack with Docker running",
  };
}

async function dryRun(source: string, root: string): Promise<void> {
  copy(source, root);
  const identity = join(root, IDENTITY);
  const committed = readSql(join(root, GENERATED_SQL));

  const before = measure(root, identity);
  permdock(["generate"], identity);
  const generated = readSql(join(root, GENERATED_SQL));

  for (const codemod of CODEMODS) permdock([...codemod, "--force"], identity);
  const generateStart = performance.now();
  permdock(["generate"], identity);
  const generateMs = Math.round(performance.now() - generateStart);
  enableProviderOptions(root);
  const after = measure(root, identity);
  const codemodded = readSql(join(root, GENERATED_SQL));

  const database = await databaseReport(root, identity);

  const result = {
    source: "centrakit",
    before,
    after,
    sql: {
      committedToBranch: diff(committed, generated),
      codemods: diff(generated, codemodded),
    },
    functions: payloadFunctions(identity),
    timings: { generateMs },
    ...database,
    steps,
  };
  writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  const failed = steps.filter(
    (step) => step.code !== 0 && step.findings !== true,
  );
  process.stdout.write(
    `config lines ${String(before.config["total"])} -> ${String(after.config["total"])}; ${String(failed.length)} failed steps; see ${relative(ROOT, OUT)}${values.keep ? `; copy at ${root}` : ""}\n`,
  );
  process.exitCode = failed.length > 0 ? 1 : 0;
}

const source = values.centrakit ?? join(ROOT, "..", "CentraKit");
if (existsSync(join(source, IDENTITY, "permdock.config.ts"))) {
  const work = mkdtempSync(join(tmpdir(), "centrakit-dry-run-"));
  try {
    await dryRun(source, join(work, "centrakit"));
  } finally {
    if (!values.keep) rmSync(work, { recursive: true, force: true });
  }
} else {
  fixtureOnly(source);
}
