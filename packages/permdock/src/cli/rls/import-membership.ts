import type { RlsMembershipTable } from "../types.ts";
import type { MembershipSubquery } from "./import-nodes.ts";

import {
  asNode,
  boolOp,
  columnName,
  constValue,
  isAuthUid,
  isCurrentSettingUserId,
  operatorName,
  selectWhere,
  unwrap,
} from "./import-nodes.ts";

/**
 * What the `where` of a membership subquery on `table` says, or `undefined`
 * when any part of it cannot be read as one. A subquery imports as `memberOf`
 * only when it binds the membership row to the signed-in user and to the policy
 * row, and filters roles with string literals at most: a predicate left unread
 * would widen the imported condition.
 */
export function membershipRoles(
  subquery: MembershipSubquery,
  table: RlsMembershipTable,
): { readonly field: string; readonly roles: readonly string[] } | undefined {
  const where = selectWhere(subquery.select);
  if (where === undefined) {
    return undefined;
  }
  const scopeColumns = new Set(
    [
      ...Object.values(table.columns ?? {}),
      table.tenant,
      table.team,
      table.id,
    ].filter((column): column is string => column !== undefined),
  );
  if (
    subquery.field !== undefined &&
    !scopeColumns.has(selectTarget(subquery.select) ?? "")
  ) {
    return undefined;
  }
  const roleColumn = typeof table.role === "string" ? table.role : undefined;
  const roles: string[] = [];
  let user = false;
  let field = subquery.field;
  for (const conjunct of conjuncts(where)) {
    const read = readConjunct(conjunct, table, roleColumn, scopeColumns);
    if (read === undefined) {
      return undefined;
    }
    if (read.kind === "user") {
      user = true;
    } else if (read.kind === "row") {
      if (field !== undefined && field !== read.field) {
        return undefined;
      }
      field = read.field;
    } else if (read.kind === "roles") {
      roles.push(...read.roles);
    }
  }
  return user && field !== undefined
    ? { field, roles: [...new Set(roles)] }
    : undefined;
}

type Read =
  | { readonly kind: "user" }
  | { readonly kind: "row"; readonly field: string }
  | { readonly kind: "roles"; readonly roles: readonly string[] }
  | { readonly kind: "active" };

/** The column a `select <column> from …` returns. */
function selectTarget(select: unknown): string | undefined {
  const targets = asNode(asNode(select)?.["SelectStmt"])?.["targetList"];
  if (!Array.isArray(targets) || targets.length !== 1) {
    return undefined;
  }
  return columnName(asNode(asNode(targets[0])?.["ResTarget"])?.["val"]);
}

function conjuncts(value: unknown): readonly unknown[] {
  if (boolOp(value) !== "and") {
    return [value];
  }
  const args = asNode(asNode(unwrap(value))?.["BoolExpr"])?.["args"];
  return Array.isArray(args) ? args.flatMap((arg) => conjuncts(arg)) : [];
}

function readConjunct(
  value: unknown,
  table: RlsMembershipTable,
  roleColumn: string | undefined,
  scopeColumns: ReadonlySet<string>,
): Read | undefined {
  const node = asNode(unwrap(value));
  const nullTest = asNode(node?.["NullTest"]);
  if (nullTest !== undefined) {
    const column = columnName(nullTest["arg"]);
    const isNull =
      nullTest["nulltesttype"] === "IS_NULL" ||
      nullTest["nulltesttype"] === 0 ||
      nullTest["nulltesttype"] === undefined;
    return isNull &&
      column !== undefined &&
      (column === table.disabledAt || column === table.expiresAt)
      ? { kind: "active" }
      : undefined;
  }
  const expr = asNode(node?.["A_Expr"]);
  if (expr === undefined || operatorName(node) !== "=") {
    return undefined;
  }
  const kind = expr["kind"];
  const left = columnName(expr["lexpr"]);
  if (kind === "AEXPR_OP_ANY" || kind === 2) {
    // `role = any(array['a', 'b'])`, a cast to an enum array included.
    const elements = asNode(asNode(unwrap(expr["rexpr"]))?.["A_ArrayExpr"])?.[
      "elements"
    ];
    if (
      left === undefined ||
      left !== roleColumn ||
      !Array.isArray(elements) ||
      elements.length === 0
    ) {
      return undefined;
    }
    const values = elements.map((item) => constValue(item));
    return values.every((item): item is string => typeof item === "string")
      ? { kind: "roles", roles: values }
      : undefined;
  }
  if (kind === "AEXPR_IN" || kind === 7) {
    const raw = expr["rexpr"];
    const items = asNode(raw)?.["List"];
    const list = Array.isArray(raw) ? raw : asNode(items)?.["items"];
    if (
      left === undefined ||
      left !== roleColumn ||
      !Array.isArray(list) ||
      list.length === 0
    ) {
      return undefined;
    }
    const values = list.map((item) => constValue(item));
    return values.every((item): item is string => typeof item === "string")
      ? { kind: "roles", roles: values }
      : undefined;
  }
  const right = columnName(expr["rexpr"]);
  for (const [column, other, otherColumn] of [
    [left, expr["rexpr"], right],
    [right, expr["lexpr"], left],
  ] as const) {
    if (column === undefined) {
      continue;
    }
    if (
      column === table.user &&
      (isAuthUid(other) || isCurrentSettingUserId(other))
    ) {
      return { kind: "user" };
    }
    if (column === roleColumn) {
      const role = constValue(other);
      return typeof role === "string"
        ? { kind: "roles", roles: [role] }
        : undefined;
    }
    if (scopeColumns.has(column) && otherColumn !== undefined) {
      return { kind: "row", field: otherColumn };
    }
  }
  return undefined;
}

/**
 * `condition` with every `memberOf` role read through `rls.roleValues`, so a
 * legacy role value imports as the PermDock role it stands for.
 */
export function mapRoleValues(
  condition: unknown,
  roleValues: Readonly<Record<string, string>> | undefined,
): unknown {
  if (roleValues === undefined || condition === null) {
    return condition;
  }
  if (Array.isArray(condition)) {
    return condition.map((item) => mapRoleValues(item, roleValues));
  }
  if (typeof condition !== "object") {
    return condition;
  }
  const mapped = Object.fromEntries(
    Object.entries(condition).map(([key, value]) => [
      key,
      mapRoleValues(value, roleValues),
    ]),
  );
  if (mapped["op"] === "memberOf" && Array.isArray(mapped["roles"])) {
    mapped["roles"] = mapped["roles"].map((role: unknown) =>
      typeof role === "string" && Object.hasOwn(roleValues, role)
        ? roleValues[role]
        : role,
    );
  }
  return mapped;
}
