import type { CliContext } from "./context.ts";

import { secretInput } from "./credentials.ts";

/** The flag vocabulary shared with better-supabase: one spelling per meaning. */

export const dbUrlFlags = {
  "db-url-stdin": {
    type: "boolean",
    description:
      "Read the Postgres connection string from stdin (default $DATABASE_URL, then $SUPABASE_DB_URL)",
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
 * The connection string from `--db-url-stdin`, or, when the leaf needs one,
 * `DATABASE_URL` then `SUPABASE_DB_URL`: the order better-supabase reads them.
 */
export async function dbUrl(
  ctx: CliContext,
  flags: { readonly "db-url-stdin": boolean },
  options?: { readonly required?: boolean },
): Promise<string | undefined> {
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

export const DB_URL_ENV = ["DATABASE_URL", "SUPABASE_DB_URL"] as const;

/** A string flag given with a value; a bare flag reads as `""`. */
export function given(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
