import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { CliError } from "./errors.ts";

/** Runs `supabase` with `args` in `cwd` and answers its stdout. */
export type SupabaseRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<string>;

/**
 * The nearest `node_modules/.bin/supabase` above `cwd`, else `supabase` on
 * `PATH`.
 */
function supabaseBin(cwd: string): string {
  let dir = cwd;
  for (;;) {
    const bin = join(dir, "node_modules", ".bin", "supabase");
    if (existsSync(bin)) {
      return bin;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return "supabase";
    }
    dir = parent;
  }
}

/** The project's own `supabase` binary first, then the one on `PATH`. */
const runSupabase: SupabaseRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      supabaseBin(cwd),
      [...args],
      { cwd, encoding: "utf8" },
      (error, stdout) => {
        // `supabase status --output-format json` exits 1 with an error
        // document on stdout when no stack runs.
        if (error !== null && stdout === "") {
          reject(new Error(error.message, { cause: error }));
          return;
        }
        resolve(stdout);
      },
    );
  });

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  // SAFETY: `key in value` holds on a non-null object.
  return (value as Record<string, unknown>)[key];
}

/**
 * `DB_URL` of the local Supabase stack, from `supabase status --output-format
 * json` in `cwd`, so each git worktree's stack is found without assumed ports.
 */
export async function localDbUrl(
  cwd: string,
  options: { readonly stack?: string; readonly run?: SupabaseRunner } = {},
): Promise<string> {
  const args = [
    "status",
    "--output-format",
    "json",
    ...(options.stack === undefined ? [] : ["--stack", options.stack]),
  ];
  let status: unknown;
  try {
    status = JSON.parse(await (options.run ?? runSupabase)(args, cwd));
  } catch (error) {
    throw new CliError(
      "usage",
      `PermDock CLI: --local runs supabase ${args.join(" ")}, which failed: ${error instanceof Error ? error.message : String(error)}. Install the Supabase CLI 3.2.0 or later in the project.`,
      { code: "invalid_value", extensions: { flag: "--local" } },
    );
  }
  const url = field(field(status, "env"), "DB_URL");
  if (typeof url === "string" && url !== "") {
    return url;
  }
  const message = field(field(status, "error"), "message");
  throw new CliError(
    "usage",
    `PermDock CLI: --local found no running stack${typeof message === "string" ? ` (${message})` : ""}. Start it with supabase start.`,
    { code: "invalid_value", extensions: { flag: "--local" } },
  );
}
