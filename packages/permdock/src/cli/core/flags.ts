import type { CliContext } from "./context.ts";
import type { SupabaseRunner } from "./local-stack.ts";

import { secretInput } from "./credentials.ts";
import { CliError } from "./errors.ts";
import { localDbUrl } from "./local-stack.ts";

/** The flag vocabulary shared with better-supabase: one spelling per meaning. */

export const dbUrlFlags = {
  "db-url-stdin": {
    type: "boolean",
    description:
      "Read the Postgres connection string from stdin (default $DATABASE_URL, then $SUPABASE_DB_URL)",
  },
  local: {
    type: "boolean",
    description:
      "Connect to the local Supabase stack: DB_URL from supabase status in this project",
  },
  stack: {
    type: "string",
    description: "With --local, the named stack of this worktree",
    valueHint: "name",
  },
} as const;

export const outFlag = {
  out: { type: "string", description: "File to write", valueHint: "file" },
} as const;

export const checkFlag = {
  check: {
    type: "boolean",
    description: "Exit 1 when a file on disk is stale; write nothing",
  },
} as const;

export const dryRunFlag = {
  "dry-run": {
    type: "boolean",
    description: "Print what would change; write nothing",
  },
} as const;

export const forceFlag = {
  force: {
    type: "boolean",
    description:
      "Overwrite files PermDock did not write or that changed by hand",
  },
} as const;

export const policyFlag = {
  policy: {
    type: "string",
    description: "Module exporting the policy (default policy in the config)",
    valueHint: "module",
  },
} as const;

/** `permdock generate`'s own flags, beside check, dry-run, policy and db-url. */
export const generateFlags = {
  only: {
    type: "string",
    description: "Run this plugin; repeat for more than one",
    valueHint: "plugin",
    repeatable: true,
  },
  "no-cache": {
    type: "boolean",
    description: "Emit and write even when a cache entry matches",
  },
  "cache-dir": {
    type: "string",
    description:
      "Cache directory (default node_modules/.cache/permdock or PERMDOCK_CACHE_DIR)",
    valueHint: "dir",
  },
  concurrency: {
    type: "string",
    description:
      "How many tasks run at once. 1 runs them one at a time. Default is one less than the CPU count.",
    valueHint: "n",
  },
  watch: {
    type: "boolean",
    description: "Generate again when a policy, config or plugin input changes",
  },
} as const;

export const permissionsFlag = {
  permissions: {
    type: "string",
    description:
      "Module exporting the permissions (default permissions in the config)",
    valueHint: "module",
  },
} as const;

export const failOnFlag = {
  "fail-on": {
    type: "enum",
    options: ["error", "warning"],
    default: "error",
    description: "Lowest finding severity that exits 1",
  },
} as const;

export const validatorFlag = {
  validator: {
    type: "enum",
    options: ["zod", "valibot", "arktype"],
    description: "Schema library for the generated resources (default zod)",
  },
} as const;

/**
 * The connection string from `--db-url-stdin`, from `--local` (the local
 * Supabase stack), or, when the leaf needs one, `DATABASE_URL` then
 * `SUPABASE_DB_URL`: the order better-supabase reads them.
 */
export async function dbUrl(
  ctx: CliContext,
  flags: {
    readonly "db-url-stdin": boolean;
    readonly local?: boolean | undefined;
    readonly stack?: string | undefined;
  },
  options?: { readonly required?: boolean; readonly run?: SupabaseRunner },
): Promise<string | undefined> {
  const stack = given(flags.stack);
  if (stack !== undefined && flags.local !== true) {
    throw new CliError("usage", "PermDock CLI: --stack needs --local.", {
      code: "invalid_value",
      extensions: { flag: "--stack" },
    });
  }
  if (flags.local === true) {
    if (flags["db-url-stdin"]) {
      throw new CliError(
        "usage",
        "PermDock CLI: pass --local or --db-url-stdin, not both.",
        { code: "invalid_value", extensions: { flag: "--local" } },
      );
    }
    const url = await localDbUrl(ctx.cwd, {
      ...(stack === undefined ? {} : { stack }),
      ...(options?.run === undefined ? {} : { run: options.run }),
    });
    ctx.addSecret(url);
    return url;
  }
  const piped = await secretInput(ctx, {
    flag: "db-url",
    stdin: flags["db-url-stdin"],
  });
  if (piped !== undefined || options?.required !== true) {
    return piped;
  }
  for (const name of DB_URL_ENV) {
    const value = ctx.env[name];
    if (value !== undefined && value !== "") {
      ctx.addSecret(value);
      return value;
    }
  }
  return undefined;
}

const DB_URL_ENV = ["DATABASE_URL", "SUPABASE_DB_URL"] as const;

/** A string flag given with a value; a bare flag reads as `""`. */
export function given(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * `--out` for a command that only writes a file: `-` is refused instead of
 * creating a file named `-`.
 */
export function fileOut(
  command: string,
  value: string | undefined,
): string | undefined {
  if (value === "-") {
    throw new CliError(
      "usage",
      `${command}: --out - is not supported; name a file.`,
      { code: "invalid_value", extensions: { flag: "--out" } },
    );
  }
  return given(value);
}
