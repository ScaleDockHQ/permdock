import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PermDockConfig } from "../types.ts";

import { sqlFiles } from "../files.ts";
import { parseSqlLenient } from "../sql/ast.ts";
import { resolveSchemas } from "../supabase-schemas.ts";

/**
 * Whether a schema file creates the `powersync` publication without `for all
 * tables`. pg-delta loads the schema directory into a shadow, so an `alter
 * publication` there needs the publication in the same directory, and Postgres
 * rejects `add table` on a `for all tables` publication.
 */
async function declaresPublication(
  cwd: string,
  schemaDir: string,
): Promise<boolean> {
  for (const file of sqlFiles(cwd, [schemaDir])) {
    for (const statement of await parseSqlLenient(readFileSync(file, "utf8"))) {
      if (
        statement.kind === "CreatePublicationStmt" &&
        statement.node["pubname"] === "powersync"
      ) {
        return statement.node["for_all_tables"] !== true;
      }
    }
  }
  return false;
}

/**
 * Where the publication statement goes: a schema file under pg-delta, which
 * diffs publication membership. Undefined when no schema file declares the
 * publication or the project uses another workflow, and the YAML comment
 * stays.
 */
export async function publicationPath(
  cwd: string,
  config: PermDockConfig,
): Promise<string | undefined> {
  const schemas = resolveSchemas(cwd, config);
  if (
    schemas.mode !== "pg-delta" ||
    !existsSync(join(cwd, schemas.schemaDir)) ||
    !(await declaresPublication(cwd, schemas.schemaDir))
  ) {
    return undefined;
  }
  return `${schemas.schemaDir.replace(/\/$/u, "")}/permdock/powersync_publication.sql`;
}
