import type { RunResult } from "permdock/cli";
import type { RlsPluginOptions } from "permdock/cli/plugins/rls";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "permdock/cli";
import { rls } from "permdock/cli/plugins/rls";
import { supabaseHook } from "permdock/cli/plugins/supabase-hook";

import type { AsOptions, Postgres } from "./postgres.ts";

const BOOLEAN_FLAGS = new Set([
  "check",
  "no-seeds",
  "skip-closures",
  "inline-functions",
  "force-rls",
  "policy-per-role",
  "custom-roles",
  "capabilities",
  "revoke-columns",
  "helpers-only",
  "shims",
]);

function flagValues(flags: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < flags.length; index += 1) {
    const token = flags[index] ?? "";
    if (!token.startsWith("--")) {
      continue;
    }
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      values.set(name, true);
      continue;
    }
    const next = flags[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    }
  }
  return values;
}

function textOf(
  values: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined {
  const value = values.get(name);
  return typeof value === "string" ? value : undefined;
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((item) => item === value);
}

const SPLIT_PARTS = [
  "helpers",
  "seeds",
  "indexes",
  "policies",
  "hook",
] as const;

function applyBooleans(
  options: { -readonly [K in keyof RlsPluginOptions]?: RlsPluginOptions[K] },
  values: ReadonlyMap<string, string | true>,
): void {
  if (values.get("no-seeds") === true) options.seeds = false;
  if (values.get("force-rls") === true) options.force = true;
  if (values.get("inline-functions") === true) options.inlineFunctions = true;
  if (values.get("policy-per-role") === true) options.policyPerRole = true;
  if (values.get("custom-roles") === true) options.customRoles = true;
  if (values.get("capabilities") === true) options.capabilities = true;
  if (values.get("helpers-only") === true) options.helpersOnly = true;
  if (values.get("shims") === true) options.shims = true;
  if (values.get("revoke-columns") === true) options.revokeColumns = true;
  if (textOf(values, "rbac") === "supabase") options.rbacScaffold = "supabase";
}

function pluginOptions(flags: readonly string[]): {
  readonly options: RlsPluginOptions;
  readonly check: boolean;
} {
  const values = flagValues(flags);
  const options: {
    -readonly [K in keyof RlsPluginOptions]?: RlsPluginOptions[K];
  } = {};
  const target = oneOf(textOf(values, "target"), ["sql", "drizzle", "prisma"]);
  const schemas = oneOf(textOf(values, "schemas"), [
    "pg-delta",
    "migra",
    "migrations",
  ]);
  const dialect = oneOf(textOf(values, "dialect"), ["supabase", "neon", "guc"]);
  const fields = oneOf(textOf(values, "fields"), ["views", "mask"]);
  const out = textOf(values, "out");
  const grantsOut = textOf(values, "grants-out");
  const gucPrefix = textOf(values, "guc-prefix");
  const policyName = textOf(values, "policy-name");
  const split = textOf(values, "split");
  if (target !== undefined) options.target = target;
  if (schemas !== undefined) options.schemas = schemas;
  if (dialect !== undefined) options.dialect = dialect;
  if (fields !== undefined) options.fields = fields;
  if (out !== undefined) options.out = out;
  if (grantsOut !== undefined) options.grantsOut = grantsOut;
  if (gucPrefix !== undefined) options.gucPrefix = gucPrefix;
  if (policyName !== undefined) options.policyName = policyName;
  if (split !== undefined) {
    options.split = split.split(",").flatMap((part) => {
      const known = oneOf(part, SPLIT_PARTS);
      return known === undefined ? [] : [known];
    });
  }
  applyBooleans(options, values);
  const seedsOut = textOf(values, "seeds-out");
  const backfill = textOf(values, "backfill-out");
  if (
    options.seeds !== false &&
    (seedsOut !== undefined || backfill !== undefined)
  ) {
    const mode = oneOf(textOf(values, "seeds"), ["function", "view"]);
    options.seeds = {
      ...(mode === undefined ? {} : { mode }),
      ...(seedsOut === undefined ? {} : { out: seedsOut }),
      ...(backfill === undefined ? {} : { backfill }),
    };
  }
  return { check: values.get("check") === true, options };
}

/**
 * The hook plugin, with the flags a test used to pass to `supabase hook
 * generate`.
 */
export async function hookGenerate(
  flags: readonly string[],
  options?: { readonly cwd?: string },
): Promise<RunResult> {
  const values = flagValues(flags);
  const text = (name: string): string | undefined => {
    const value = values.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const schemas = oneOf(text("schemas"), ["pg-delta", "migra", "migrations"]);
  const out = text("out");
  const schema = text("schema");
  const grantsOut = text("grants-out");
  const activeFrom = text("active-from");
  const budget = text("budget");
  return run(
    [
      "generate",
      "--only",
      "supabaseHook",
      "--no-cache",
      ...(values.get("check") === true ? ["--check"] : []),
    ],
    {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      plugins: [
        supabaseHook({
          ...(out === undefined ? {} : { out }),
          ...(schemas === undefined ? {} : { schemas }),
          ...(schema === undefined ? {} : { schema }),
          ...(grantsOut === undefined ? {} : { grantsOut }),
          ...(activeFrom === undefined ? {} : { activeFrom }),
          ...(budget === undefined ? {} : { budget }),
        }),
      ],
    },
  );
}

/** The RLS plugin, with the flags a test used to pass to `rls generate`. */
export async function rlsGenerate(
  flags: readonly string[],
  options?: { readonly cwd?: string },
): Promise<RunResult> {
  const parsed = pluginOptions(flags);
  return run(
    [
      "generate",
      "--only",
      "rls",
      "--no-cache",
      ...(parsed.check ? ["--check"] : []),
    ],
    {
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      plugins: [rls(parsed.options)],
    },
  );
}

/**
 * Runs the CLI with every `{dir}` in `args` replaced by a fresh temporary
 * directory, and returns `files` read from it. A non-zero exit throws with the
 * CLI output. The directory is removed either way.
 */
export async function generated(
  args: readonly string[],
  files: readonly string[],
  options: { readonly cwd: string },
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-generated-"));
  try {
    const result = await run(
      args.map((arg) => arg.replaceAll("{dir}", dir)),
      { cwd: options.cwd },
    );
    if (result.code !== 0) {
      throw new Error(`${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    return files.map((file) => readFileSync(join(dir, file), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `permdock generate --only rls` with `target: "sql"`, as one SQL string. */
export async function generateRls(
  cwd: string,
  args: readonly string[] = [],
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-generated-"));
  try {
    const result = await rlsGenerate(
      ["--target", "sql", "--out", join(dir, "out.sql"), ...args],
      { cwd },
    );
    if (result.code !== 0) {
      throw new Error(`generate --only rls: ${result.stdout}${result.stderr}`);
    }
    return readFileSync(join(dir, "out.sql"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A CLI command that writes one `--out` file, run in `cwd`; returns the file. */
export async function generateSql(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  if (args[0] === "rls" && args[1] === "generate") {
    return generateRls(cwd, args.slice(2));
  }
  if (args[0] === "supabase" && args[1] === "hook" && args[2] === "generate") {
    const dir = mkdtempSync(join(tmpdir(), "permdock-generated-"));
    try {
      const result = await hookGenerate(
        ["--out", join(dir, "out.sql"), ...args.slice(3)],
        { cwd },
      );
      if (result.code !== 0) {
        throw new Error(
          `generate --only supabaseHook: ${result.stdout}${result.stderr}`,
        );
      }
      return readFileSync(join(dir, "out.sql"), "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const [sql = ""] = await generated(
    [...args, "--out", "{dir}/out.sql"],
    ["out.sql"],
    { cwd },
  );
  return sql;
}

/** `--split` parts written to `{part}.sql`, joined in the order given. */
export async function generateRlsParts(
  cwd: string,
  parts: readonly string[],
  args: readonly string[] = [],
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-generated-"));
  try {
    const result = await rlsGenerate(
      [
        "--target",
        "sql",
        ...args,
        "--schemas",
        "migrations",
        "--split",
        parts.join(","),
        "--out",
        join(dir, "{part}.sql"),
      ],
      { cwd },
    );
    if (result.code !== 0) {
      throw new Error(`generate --only rls: ${result.stdout}${result.stderr}`);
    }
    return parts
      .map((part) => readFileSync(join(dir, `${part}.sql`), "utf8"))
      .join("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The settings a Supabase request carries: `request.jwt.claims` for `sub`. */
export function jwtClaims(
  sub: string,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, string>> {
  return {
    "request.jwt.claims": JSON.stringify({
      sub,
      role: "authenticated",
      ...extra,
    }),
  };
}

/**
 * The `id` column of `sql`, run as `tester` under `as` in a rolled-back
 * transaction.
 */
export async function visibleIds(
  db: Postgres,
  as: AsOptions,
  sql: string,
): Promise<string[]> {
  return db.as(as, async () =>
    (await db.tester.query<{ readonly id: string }>(sql)).rows.map(
      (row) => row.id,
    ),
  );
}

/** `select <expression> as ok` as `authenticated` with `jwtClaims(sub)`. */
export async function askAs(
  db: Postgres,
  sub: string,
  expression: string,
): Promise<unknown> {
  return db.as(
    { role: "authenticated", settings: jwtClaims(sub) },
    async () => {
      const result = await db.tester.query<{ readonly ok: unknown }>(
        `select ${expression} as ok`,
      );
      return result.rows[0]?.ok;
    },
  );
}

/**
 * The sorted ids of `rows` the instance can read with `permission`, after
 * loading their relations: what RLS must return for the same subject.
 */
export async function readableIds<T extends { readonly id: string }, P>(
  permdock: {
    readonly prefetchRelations: (permission: P, rows: readonly T[]) => unknown;
    readonly can: (permission: P, row: T) => boolean;
  },
  permission: P,
  rows: readonly T[],
): Promise<string[]> {
  await permdock.prefetchRelations(permission, rows);
  return rows
    .filter((row) => permdock.can(permission, row))
    .map((row) => row.id)
    .toSorted();
}

/**
 * `rls generate --rbac supabase` and `supabase hook generate` in `cwd`, in
 * apply order.
 */
export async function rlsAndHook(cwd: string): Promise<readonly string[]> {
  return [
    await generateRls(cwd, ["--rbac", "supabase"]),
    await generateSql(cwd, ["supabase", "hook", "generate"]),
  ];
}
