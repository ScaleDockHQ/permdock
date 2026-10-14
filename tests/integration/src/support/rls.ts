import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "permdock/cli";

import type { AsOptions, Postgres } from "./postgres.ts";

/**
 * Runs the CLI with every `{dir}` in `args` replaced by a fresh temporary
 * directory, and returns `files` read from it. A non-zero exit throws with
 * the CLI output. The directory is removed either way.
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

/** A CLI command that writes one `--out` file, run in `cwd`; returns the file. */
export async function generateSql(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const [sql = ""] = await generated(
    [...args, "--out", "{dir}/out.sql"],
    ["out.sql"],
    { cwd },
  );
  return sql;
}

/** `permdock rls generate --target sql ...args` in `cwd`, as one SQL string. */
export async function generateRls(
  cwd: string,
  args: readonly string[] = [],
): Promise<string> {
  return generateSql(cwd, ["rls", "generate", "--target", "sql", ...args]);
}

/** `--split` parts written to `{part}.sql`, joined in the order given. */
export async function generateRlsParts(
  cwd: string,
  parts: readonly string[],
  args: readonly string[] = [],
): Promise<string> {
  const files = await generated(
    [
      "rls",
      "generate",
      "--target",
      "sql",
      ...args,
      "--schemas",
      "migrations",
      "--split",
      parts.join(","),
      "--out",
      "{dir}/{part}.sql",
    ],
    parts.map((part) => `${part}.sql`),
    { cwd },
  );
  return files.join("\n");
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

/** The `id` column of `sql`, run as `tester` under `as` in a rolled-back transaction. */
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
    readonly loadRelations: (permission: P, rows: readonly T[]) => unknown;
    readonly can: (permission: P, row: T) => boolean;
  },
  permission: P,
  rows: readonly T[],
): Promise<string[]> {
  await permdock.loadRelations(permission, rows);
  return rows
    .filter((row) => permdock.can(permission, row))
    .map((row) => row.id)
    .toSorted();
}

/** `rls generate --rbac supabase` and `supabase hook generate` in `cwd`, in apply order. */
export async function rlsAndHook(cwd: string): Promise<readonly string[]> {
  return [
    await generateRls(cwd, ["--rbac", "supabase"]),
    await generateSql(cwd, ["supabase", "hook", "generate"]),
  ];
}
