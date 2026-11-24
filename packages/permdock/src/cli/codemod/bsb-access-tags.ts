import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PlannedFile } from "../core/files.ts";
import type { CommandResult } from "../core/result.ts";
import type { SqlNode } from "../sql/ast.ts";
import type { BsbSql, BsbTag } from "../sql/bsb-access.ts";

import { isRecord } from "../../core/compact.ts";
import { scopeList } from "../../core/scopes.ts";
import { CliError } from "../core/errors.ts";
import { applyFiles, refuseDirty } from "../core/files.ts";
import { rel } from "../files.ts";
import { readConfig } from "../project/config.ts";
import { requirePolicy } from "../project/load.ts";
import { keyReason, keyReasons } from "../rls/key-reasons.ts";
import { parseSqlFile, removeStatements } from "../sql/ast.ts";
import {
  bsbSqlMissing,
  loadBsbSql,
  schemaSqlFiles,
} from "../sql/bsb-access.ts";
import { svals, tenantCheck } from "../sql/tenant-check.ts";
import { supabaseDir } from "../supabase-dir.ts";

/** What `permdock codemod bsb-access-tags --json` prints. */
export type AccessTagReport = {
  /** Each table moved to a tag, with the operations and keys the tag holds. */
  readonly moved: readonly {
    readonly table: string;
    readonly operations: Readonly<Record<string, string>>;
  }[];
  /** Plain-form policies left in place, with the reason. */
  readonly kept: readonly {
    readonly table: string;
    readonly policy: string;
    readonly reason: string;
  }[];
  readonly files: readonly string[];
};

type Operation = "read" | "create" | "update" | "delete";

type PlainPolicy = {
  readonly node: SqlNode;
  readonly file: string;
  readonly name: string;
  readonly table: string;
  readonly operation: Operation;
  readonly column: string;
  readonly key: string;
  readonly guard: boolean;
};

const ALL_OPERATIONS: readonly Operation[] = [
  "read",
  "create",
  "update",
  "delete",
];

function policyTarget(node: SqlNode): {
  readonly table: string;
  readonly operations: readonly Operation[];
} {
  const relation = node.node["table"];
  const table = isRecord(relation)
    ? `${typeof relation["schemaname"] === "string" ? relation["schemaname"] : "public"}.${String(relation["relname"])}`
    : "";
  const operation = COMMANDS[String(node.node["cmd_name"])];
  return {
    table,
    operations: operation === undefined ? ALL_OPERATIONS : [operation],
  };
}

async function bsbSql(cwd: string): Promise<BsbSql> {
  const module = await loadBsbSql(cwd);
  if (module === undefined) {
    throw new CliError("usage", bsbSqlMissing("codemod bsb-access-tags"), {
      code: "dependency_missing",
    });
  }
  return module;
}

const GUARDS = new Set([
  "permdock.permdock_actor_may_write",
  "better_supabase.actor_may_write",
]);

function isGuard(expr: unknown): boolean {
  const call: unknown = isRecord(expr) ? expr["FuncCall"] : undefined;
  return (
    isRecord(call) &&
    GUARDS.has(svals(call["funcname"]).join(".")) &&
    call["args"] === undefined
  );
}

/** The tenant check of a policy expression, alone or `and` the actor guard. */
function readExpr(
  expr: unknown,
  helper: string,
):
  | { readonly column: string; readonly key: string; readonly guard: boolean }
  | undefined {
  const plain = tenantCheck(expr, helper);
  if (plain !== undefined) {
    return { ...plain, guard: false };
  }
  const bool: unknown = isRecord(expr) ? expr["BoolExpr"] : undefined;
  if (
    !isRecord(bool) ||
    bool["boolop"] !== "AND_EXPR" ||
    !Array.isArray(bool["args"]) ||
    bool["args"].length !== 2
  ) {
    return undefined;
  }
  const [first, second] = bool["args"];
  const check = tenantCheck(first, helper);
  return check !== undefined && isGuard(second)
    ? { ...check, guard: true }
    : undefined;
}

const COMMANDS: Readonly<Record<string, Operation>> = {
  select: "read",
  insert: "create",
  update: "update",
  delete: "delete",
};

function plainPolicy(
  file: string,
  node: SqlNode,
  helper: string,
):
  | PlainPolicy
  | { readonly reason: string; readonly name: string; readonly table: string }
  | undefined {
  if (node.kind !== "CreatePolicyStmt") {
    return undefined;
  }
  const relation = node.node["table"];
  const name =
    typeof node.node["policy_name"] === "string"
      ? node.node["policy_name"]
      : "";
  const table = isRecord(relation)
    ? `${typeof relation["schemaname"] === "string" ? relation["schemaname"] : "public"}.${String(relation["relname"])}`
    : "";
  const using = readExpr(node.node["qual"], helper);
  const check = readExpr(node.node["with_check"], helper);
  if (using === undefined && check === undefined) {
    return undefined;
  }
  const operation = COMMANDS[String(node.node["cmd_name"])];
  if (operation === undefined) {
    return { name, table, reason: "a policy for all commands" };
  }
  if (node.node["permissive"] !== true) {
    return { name, table, reason: "a restrictive policy" };
  }
  const roles = Array.isArray(node.node["roles"]) ? node.node["roles"] : [];
  const roleNames = roles.flatMap((role: unknown) => {
    const spec: unknown = isRecord(role) ? role["RoleSpec"] : undefined;
    return isRecord(spec) && typeof spec["rolename"] === "string"
      ? [spec["rolename"]]
      : [];
  });
  if (
    roleNames.length !== 1 ||
    roleNames[0] !== "authenticated" ||
    roles.length !== 1
  ) {
    return {
      name,
      table,
      reason: "a policy for a role other than authenticated",
    };
  }
  const read = operation === "create" ? check : using;
  if (read === undefined) {
    return { name, table, reason: "an expression the tag does not render" };
  }
  if (
    operation === "update" &&
    (check === undefined ||
      check.key !== read.key ||
      check.column !== read.column ||
      check.guard !== read.guard) &&
    node.node["with_check"] !== undefined
  ) {
    return {
      name,
      table,
      reason: "an update check that differs from its using clause",
    };
  }
  if (operation === "read" || operation === "delete" ? read.guard : false) {
    return { name, table, reason: "an actor guard on a read or delete" };
  }
  return {
    node,
    file,
    name,
    table,
    operation,
    column: read.column,
    key: read.key,
    guard: read.guard,
  };
}

function quoted(table: string): string {
  return table
    .split(".")
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join(".");
}

/** The comment a file sets on `table`, and the statement that sets it. */
function tableComment(
  nodes: readonly SqlNode[],
  table: string,
): { readonly node: SqlNode; readonly comment: string } | undefined {
  for (const node of nodes) {
    if (
      node.kind !== "CommentStmt" ||
      node.node["objtype"] !== "OBJECT_TABLE"
    ) {
      continue;
    }
    const object = node.node["object"];
    const names =
      isRecord(object) && isRecord(object["List"])
        ? svals(object["List"]["items"])
        : [];
    const name =
      names.length === 1 ? `public.${names[0] ?? ""}` : names.join(".");
    if (name === table) {
      return {
        node,
        comment:
          typeof node.node["comment"] === "string" ? node.node["comment"] : "",
      };
    }
  }
  return undefined;
}

/**
 * `permdock codemod bsb-access-tags`: moves each table whose policies for an
 * operation are exactly `<column> in (select
 * <schema>.permitted_<scope>_ids('<key>'))` to a `@bsb access` tag, which
 * better-supabase renders through `permitted_<scope>_ids_by_permission`. A key
 * moves only when both helpers answer the same for it; any other key stays and
 * is listed.
 */
export async function runAccessTags(options: {
  readonly cwd: string;
  readonly schemas?: string;
  readonly dryRun: boolean;
  /**
   * Write nothing, list what would move and why the rest stays, exit 1 when a
   * table would move.
   */
  readonly check?: boolean;
  readonly force: boolean;
  readonly json: boolean;
}): Promise<CommandResult> {
  const dryRun = options.dryRun || options.check === true;
  const { config } = await readConfig(options.cwd);
  const policy = await requirePolicy(
    options.cwd,
    config.policy,
    "codemod bsb-access-tags needs `policy` in permdock.config",
  );
  const root = scopeList(policy.scopes)[0]?.name;
  if (root === undefined) {
    throw new CliError(
      "usage",
      "codemod bsb-access-tags needs a policy with a tenant scope",
      { code: "invalid_value" },
    );
  }
  const schema = config.rls?.schema ?? "permdock";
  const helper = `${schema}.permitted_${root}_ids`;
  const keys = keyReasons(config, policy, options.cwd);
  const bsb = await bsbSql(options.cwd);
  const canIn = `{tenant} in (select ${schema}.permitted_${root}_ids_by_permission({permission}))`;
  const kept: { table: string; policy: string; reason: string }[] = [];
  const moved: { table: string; operations: Record<string, string> }[] = [];
  const planned: PlannedFile[] = [];
  for (const file of schemaSqlFiles(
    join(options.cwd, options.schemas ?? `${supabaseDir(options.cwd)}/schemas`),
  )) {
    const text = readFileSync(file, "utf8");
    const nodes = await parseSqlFile(text);
    const byTable = new Map<string, PlainPolicy[]>();
    const others = new Map<string, Set<Operation>>();
    for (const node of nodes) {
      const found = plainPolicy(file, node, helper);
      if (found === undefined) {
        if (node.kind === "CreatePolicyStmt") {
          const { table, operations } = policyTarget(node);
          others.set(
            table,
            new Set([...(others.get(table) ?? []), ...operations]),
          );
        }
        continue;
      }
      if ("reason" in found) {
        kept.push({
          table: found.table,
          policy: found.name,
          reason: found.reason,
        });
        continue;
      }
      byTable.set(found.table, [...(byTable.get(found.table) ?? []), found]);
    }
    let next = text;
    const removed = new Set<SqlNode>();
    for (const [table, policies] of byTable) {
      const operations: Record<string, string> = {};
      const chosen: PlainPolicy[] = [];
      const counts = new Map<Operation, number>();
      for (const item of policies) {
        counts.set(item.operation, (counts.get(item.operation) ?? 0) + 1);
      }
      for (const item of policies) {
        const shared =
          counts.get(item.operation) !== 1 ||
          others.get(table)?.has(item.operation) === true;
        const reason = keys.swappable.has(item.key)
          ? shared
            ? `${table} has another policy for ${item.operation}`
            : item.column === policies[0]?.column
              ? undefined
              : "a tenant column that differs from the table's other policies"
          : `key ${item.key}: ${keyReason(keys, item.key)}, so permitted_${root}_ids_by_permission answers differently`;
        if (reason === undefined) {
          operations[item.operation] = item.key;
          chosen.push(item);
        } else {
          kept.push({ table, policy: item.name, reason });
        }
      }
      const writes = chosen.filter(
        (item) => item.operation === "create" || item.operation === "update",
      );
      if (
        writes.some((item) => item.guard) &&
        !writes.every((item) => item.guard)
      ) {
        for (const item of chosen) {
          kept.push({
            table,
            policy: item.name,
            reason: "the actor guard is on create or update but not both",
          });
        }
        continue;
      }
      if (chosen.length === 0) {
        continue;
      }
      const guard = writes.some((item) => item.guard);
      const tag: BsbTag = {
        name: "access",
        args: {
          tenant: chosen[0]?.column ?? "",
          ...operations,
          ...(guard ? { "actor-guard": true } : {}),
        },
      };
      const [tableSchema = "public", tableName = ""] = table.split(".");
      for (const item of chosen) {
        removed.add(item.node);
      }
      const existing = tableComment(nodes, table);
      const comment = bsb.commentOnTableSql(
        quoted(table),
        bsb.setBsbTag(existing?.comment ?? null, "access", tag),
      );
      if (existing === undefined) {
        next = `${next.trimEnd()}\n\n${comment}\n`;
      } else {
        next = next.replace(existing.node.text, comment.replace(/;\s*$/u, ""));
      }
      const block = bsb.renderTagBlock("access", tableSchema, tableName, tag, {
        canIn,
        ...(guard
          ? { actorMayWrite: `${schema}.permdock_actor_may_write()` }
          : {}),
      });
      next = bsb.setTagBlock(next, "access", block);
      moved.push({ table, operations });
    }
    if (removed.size > 0) {
      const texts = new Set([...removed].map((node) => node.text));
      next = removeStatements(next, await parseSqlFile(next), (node) =>
        texts.has(node.text),
      );
      planned.push({ path: file, text: next });
    }
  }
  if (!dryRun) {
    refuseDirty({
      command: "codemod",
      invocation: "codemod bsb-access-tags",
      cwd: options.cwd,
      paths: planned.map((file) => file.path),
      force: options.force,
    });
    applyFiles(options.cwd, planned);
  }
  const report: AccessTagReport = {
    moved,
    kept,
    files: planned.map((file) => rel(options.cwd, file.path)),
  };
  const code = options.check === true && moved.length > 0 ? 1 : 0;
  if (options.json) {
    return { code, output: JSON.stringify(report, null, 2), data: report };
  }
  return {
    code,
    output: [
      `permdock codemod bsb-access-tags: ${dryRun ? "would move" : "moved"} ${String(moved.length)} ${moved.length === 1 ? "table" : "tables"} to @bsb access tags`,
      ...moved.map(
        (entry) =>
          `  ${entry.table}: ${Object.entries(entry.operations)
            .map(([op, key]) => `${op}=${key}`)
            .join(" ")}`,
      ),
      ...kept.map(
        (entry) => `  kept ${entry.table} ${entry.policy}: ${entry.reason}`,
      ),
    ].join("\n"),
  };
}
