import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SqlNode } from "./ast.ts";

import { isRecord } from "../../core/compact.ts";
import { supabaseDir } from "../supabase-dir.ts";
import { SqlSyntaxError, parseSqlFile } from "./ast.ts";
import { loadBsbSql, schemaSqlFiles } from "./bsb-access.ts";

export type WriteCommand = "insert" | "update" | "delete";

/** A table whose schema files hold a permissive client write policy. */
export type SchemaWrite = {
  readonly table: string;
  readonly commands: readonly WriteCommand[];
};

const WRITES: Readonly<Record<string, readonly WriteCommand[]>> = {
  insert: ["insert"],
  update: ["update"],
  delete: ["delete"],
  all: ["insert", "update", "delete"],
};

function clientRole(role: unknown): boolean {
  const spec: unknown = isRecord(role) ? role["RoleSpec"] : undefined;
  if (!isRecord(spec)) {
    return false;
  }
  return (
    spec["roletype"] === "ROLESPEC_PUBLIC" ||
    spec["rolename"] === "authenticated"
  );
}

function writePolicy(
  node: SqlNode,
):
  | { readonly table: string; readonly commands: readonly WriteCommand[] }
  | undefined {
  if (node.kind !== "CreatePolicyStmt" || node.node["permissive"] !== true) {
    return undefined;
  }
  const commands = WRITES[String(node.node["cmd_name"])];
  const roles = Array.isArray(node.node["roles"]) ? node.node["roles"] : [];
  const relation = node.node["table"];
  if (
    commands === undefined ||
    !roles.some((role: unknown) => clientRole(role)) ||
    !isRecord(relation)
  ) {
    return undefined;
  }
  const schema =
    typeof relation["schemaname"] === "string"
      ? relation["schemaname"]
      : "public";
  return { table: `${schema}.${String(relation["relname"])}`, commands };
}

/** The tables whose `@bsb access` tag sets `actor-guard`. */
async function guardedByTag(
  cwd: string,
  files: readonly string[],
): Promise<ReadonlySet<string>> {
  const bsb = await loadBsbSql(cwd);
  const out = new Set<string>();
  if (bsb === undefined) {
    return out;
  }
  for (const file of files) {
    for (const entry of bsb.tableTagComments(readFileSync(file, "utf8"))) {
      const tags = bsb.parseBsbComment(entry.comment).tags;
      if (
        tags.some(
          (tag) => tag.name === "access" && tag.args["actor-guard"] === true,
        )
      ) {
        out.add(`${entry.schema}.${entry.name}`);
      }
    }
  }
  return out;
}

/**
 * The tables in `dir` (default `supabase/schemas`) whose permissive policies
 * let `authenticated` or `public` write, with the write commands, sorted. On a
 * table whose `@bsb access` tag carries `actor-guard`, only `delete` stays: the
 * tag guards `insert` and `update`. A file that does not parse is skipped.
 */
export async function schemaWrites(
  cwd: string,
  dir = `${supabaseDir(cwd)}/schemas`,
): Promise<readonly SchemaWrite[]> {
  const files = schemaSqlFiles(join(cwd, dir));
  const found = new Map<string, Set<WriteCommand>>();
  for (const file of files) {
    let nodes: readonly SqlNode[];
    try {
      nodes = await parseSqlFile(readFileSync(file, "utf8"));
    } catch (cause) {
      if (cause instanceof SqlSyntaxError) {
        continue;
      }
      throw cause;
    }
    for (const node of nodes) {
      const write = writePolicy(node);
      if (write !== undefined) {
        found.set(
          write.table,
          new Set([...(found.get(write.table) ?? []), ...write.commands]),
        );
      }
    }
  }
  const tagged = await guardedByTag(cwd, files);
  return [...found]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([table, commands]) => {
      const kept = (["insert", "update", "delete"] as const).filter(
        (command) =>
          commands.has(command) && !(tagged.has(table) && command !== "delete"),
      );
      return kept.length === 0 ? [] : [{ table, commands: kept }];
    });
}
