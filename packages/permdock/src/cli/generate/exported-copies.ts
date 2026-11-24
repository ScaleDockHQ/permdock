import type { PermDockConfig } from "../types.ts";

import { CliError } from "../core/errors.ts";
import {
  foreignSchemaFiles,
  inReservedDir,
  ownedObjects,
  shownKey,
  withoutOwned,
} from "../sql/exported-copies.ts";
import { resolveSchemas } from "../supabase-schemas.ts";

type Emitted = {
  readonly plugin: string;
  readonly path: string;
  readonly contents: string;
};

/**
 * The exported files rewritten without their copies of the functions and
 * policies the plugins emit, with one note each. Only under pg-delta, whose `db
 * schema declarative generate` writes every object once more per file.
 *
 * @throws {CliError} When a plugin emits into `_custom/` or `_cluster/`.
 */
export async function exportedCopyFiles(
  cwd: string,
  config: PermDockConfig,
  emitted: readonly Emitted[],
): Promise<{ readonly files: Emitted[]; readonly notes: string[] }> {
  const schemas = resolveSchemas(cwd, config);
  if (schemas.mode !== "pg-delta") {
    return { files: [], notes: [] };
  }
  const schemaDir = schemas.schemaDir.replace(/\/$/u, "");
  const reserved = emitted.find(
    (file) =>
      file.path.startsWith(`${schemaDir}/`) &&
      inReservedDir(schemaDir, file.path),
  );
  if (reserved !== undefined) {
    throw new CliError(
      "usage",
      `${reserved.plugin} would write ${reserved.path}; _custom/ and _cluster/ belong to the pg-delta export, so set its out elsewhere under ${schemaDir}`,
      { code: "config_invalid" },
    );
  }
  const foreign = foreignSchemaFiles(
    cwd,
    schemaDir,
    new Set(emitted.map((file) => file.path)),
  );
  if (foreign.length === 0) {
    return { files: [], notes: [] };
  }
  const ownerOf = new Map<string, string>();
  for (const file of emitted) {
    if (file.path.endsWith(".sql")) {
      for (const key of await ownedObjects([file.contents])) {
        ownerOf.set(key, file.plugin);
      }
    }
  }
  const owned = new Set(ownerOf.keys());
  const files: Emitted[] = [];
  const notes: string[] = [];
  for (const file of foreign) {
    const stripped = await withoutOwned(file.text, owned);
    const [first] = stripped.removed;
    if (first === undefined) {
      continue;
    }
    files.push({
      plugin: ownerOf.get(first) ?? "rls",
      path: file.path,
      contents: stripped.text,
    });
    notes.push(
      `removed the exported copy of ${stripped.removed.map(shownKey).join(", ")} from ${file.path}`,
    );
  }
  return { files, notes };
}
