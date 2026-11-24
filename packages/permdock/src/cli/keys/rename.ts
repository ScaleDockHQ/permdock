import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { PlannedFile } from "../core/files.ts";
import type { CommandResult } from "../core/result.ts";
import type { PermDockConfig } from "../types.ts";

import { renamedKeys } from "../../core/permission-registry.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { CliError } from "../core/errors.ts";
import { applyFiles, fileSummary, refuseDirty } from "../core/files.ts";
import {
  asPermissionTree,
  leavesOf,
  loadModule,
  pickNamed,
} from "../project/load.ts";
import { resolveAuthorize } from "../rls/rbac.ts";
import { customRolesOn } from "../sql/shared.ts";
import { renameGrantsSql } from "./rename-sql.ts";
import { renameInTree } from "./rename-tree.ts";

const KEY = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)+$/u;

const MIGRATION_DIRS = ["supabase/migrations", "migrations", "db/migrations"];

export type KeysRenameReport = {
  readonly from: string;
  readonly to: string;
  /** `to` already existed, so `from`'s grants merge into it. */
  readonly merged: boolean;
  readonly permissions: string;
  /** The data migration; `null` without custom roles stored in the database. */
  readonly migration: string | null;
  readonly notes: readonly string[];
};

function usage(message: string): CliError {
  return new CliError("usage", message, { code: "invalid_value" });
}

/**
 * `<dir>/<yyyymmddhhmmss>_permdock_keys_rename.sql` in the first migrations
 * dir.
 */
function defaultMigration(cwd: string, now: Date): string {
  const dir =
    MIGRATION_DIRS.find((candidate) => existsSync(join(cwd, candidate))) ??
    "supabase/migrations";
  const stamp = now.toISOString().replaceAll(/\D/gu, "").slice(0, 14);
  return `${dir}/${stamp}_permdock_keys_rename.sql`;
}

/**
 * `permdock keys rename <from> <to>`: rewrites the permissions module so `from`
 * is a former key of `to`, and with custom roles stored in the database writes
 * a data migration that moves their grants to the current keys.
 */
export async function runKeysRename(options: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly from: string;
  readonly to: string;
  readonly migration?: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly now: Date;
}): Promise<CommandResult> {
  const { cwd, config, from, to } = options;
  for (const key of [from, to]) {
    if (!KEY.test(key)) {
      throw usage(
        `PermDock CLI: ${key} is not a permission key such as file.read`,
      );
    }
  }
  if (from === to) {
    throw usage("PermDock CLI: keys rename needs two different keys");
  }
  const path = config.permissions;
  if (path === undefined) {
    throw new CliError(
      "usage",
      "PermDock CLI: keys rename needs permissions in permdock.config.ts",
      { code: "config_invalid" },
    );
  }
  const abs = resolve(cwd, path);
  const tree = asPermissionTree(
    pickNamed(await loadModule(abs, { fresh: true }), ["permissions"]),
  );
  const keys = new Set(leavesOf(tree).map((leaf) => leaf.key));
  const former = renamedKeys(tree);
  if (!keys.has(from)) {
    const current = former.get(from);
    throw usage(
      current === undefined
        ? `PermDock CLI: ${from} is not a permission key in ${path}`
        : `PermDock CLI: ${from} is already renamed to ${current}`,
    );
  }
  const taken = former.get(to);
  if (taken !== undefined) {
    throw usage(
      `PermDock CLI: ${to} is a former key of ${taken}; rename to ${taken} instead`,
    );
  }
  const merged = keys.has(to);
  const rewrite = renameInTree({
    file: path,
    text: readFileSync(abs, "utf8"),
    from,
    to,
    merge: merged,
  });
  const renamed: Record<string, string> = { [from]: to };
  for (const [old, current] of former) {
    renamed[old] = current === from ? to : current;
  }
  const stored =
    customRolesOn(config.rls) && resolveAuthorize(config) === "database";
  const migration = stored
    ? (options.migration ?? defaultMigration(cwd, options.now))
    : undefined;
  const planned: PlannedFile[] = [
    { path: relative(cwd, abs), text: rewrite.text },
    ...(migration === undefined
      ? []
      : [
          {
            path: migration,
            text: renameGrantsSql({
              schema: config.rls?.schema ?? PERMDOCK_SCHEMA,
              renamed,
              invocation: `permdock keys rename ${from} ${to}`,
            }),
          },
        ]),
  ];
  if (!options.dryRun) {
    refuseDirty({
      command: "keys rename",
      invocation: `keys rename ${from} ${to}`,
      cwd,
      paths: [relative(cwd, abs)],
      force: options.force,
    });
  }
  const applied = applyFiles(cwd, planned, { dryRun: options.dryRun });
  const notes = [
    ...rewrite.notes,
    `references to permissions.${from} need permissions.${to}; the type checker lists them`,
    ...(migration === undefined
      ? [
          "no data migration: custom roles are not stored in the database (rls.customRoles with authorize 'database')",
        ]
      : []),
  ];
  const report: KeysRenameReport = {
    from,
    to,
    merged,
    permissions: relative(cwd, abs),
    migration: migration ?? null,
    notes,
  };
  const next = [
    {
      when: "to regenerate the catalog and the SQL",
      command: "permdock generate",
    },
  ];
  if (options.json) {
    return {
      code: 0,
      output: JSON.stringify(report, null, 2),
      data: report,
      next,
    };
  }
  return {
    code: 0,
    output: [
      `${from} -> ${to}${merged ? " (merged)" : ""}`,
      fileSummary(applied, options.dryRun),
      ...notes,
    ].join("\n"),
    next,
  };
}
