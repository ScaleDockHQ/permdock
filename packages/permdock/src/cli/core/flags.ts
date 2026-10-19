import type { CliContext } from "./context.ts";

import { secretInput } from "./credentials.ts";

/** The flag vocabulary shared with better-supabase: one spelling per meaning. */

export const dbUrlFlags = {
  "db-url": {
    type: "string",
    description: "Postgres connection string",
    valueHint: "url",
    secret: { stdinFlag: "db-url-stdin", env: "DATABASE_URL" },
  },
  "db-url-stdin": {
    type: "boolean",
    description:
      "Read the connection string from stdin, keeping it out of ps and shell history",
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

/** The connection string from `--db-url-stdin`, `--db-url`, or `DATABASE_URL` when the leaf needs one. */
export function dbUrl(
  ctx: CliContext,
  flags: {
    readonly "db-url": string | undefined;
    readonly "db-url-stdin": boolean;
  },
  options?: { readonly required?: boolean },
): Promise<string | undefined> {
  return secretInput(ctx, {
    flag: "db-url",
    value: flags["db-url"],
    stdin: flags["db-url-stdin"],
    env: "DATABASE_URL",
    useEnv: options?.required === true,
  });
}

/** A string flag given with a value; a bare flag reads as `""`. */
export function given(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
