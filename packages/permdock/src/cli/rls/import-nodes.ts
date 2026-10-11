import { createHash } from "node:crypto";
import { deparse, parse } from "pgsql-parser";

import type { ConditionValue, SqlFunctionArg } from "../../index.ts";
import type { RlsFunctionMapping } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { USER_ID_HELPER } from "../sql/subject.ts";

type PgNode = Record<string, unknown>;

export function asNode(value: unknown): PgNode | undefined {
  return isRecord(value) ? value : undefined;
}

function stringVal(value: unknown): string | undefined {
  const node = asNode(value);
  if (node === undefined) {
    return undefined;
  }
  const inner = asNode(node["String"]);
  if (inner !== undefined) {
    if (typeof inner["sval"] === "string") {
      return inner["sval"];
    }
    if (typeof inner["str"] === "string") {
      return inner["str"];
    }
  }
  if (typeof node["str"] === "string") {
    return node["str"];
  }
  if (typeof node["sval"] === "string") {
    return node["sval"];
  }
  return undefined;
}

export function unwrap(value: unknown): unknown {
  const node = asNode(value);
  if (node === undefined) {
    return value;
  }
  const cast = asNode(node["TypeCast"]);
  if (cast !== undefined) {
    return unwrap(cast["arg"]);
  }
  return value;
}

export function columnName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const ref = asNode(node?.["ColumnRef"]);
  const fields = ref?.["fields"];
  if (!Array.isArray(fields) || fields.length === 0) {
    return undefined;
  }
  return stringVal(fields.at(-1));
}

export function funcName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const call = asNode(node?.["FuncCall"]);
  const names = call?.["funcname"];
  if (!Array.isArray(names) || names.length === 0) {
    return undefined;
  }
  return names.map((item) => stringVal(item) ?? "").join(".");
}

/** The expression of a scalar `(select <expr>)`, the InitPlan form generate writes. */
export function scalarSubselect(value: unknown): unknown {
  const sub = asNode(asNode(unwrap(value))?.["SubLink"]);
  const select = asNode(asNode(sub?.["subselect"])?.["SelectStmt"]);
  const targets = select?.["targetList"];
  if (!Array.isArray(targets) || targets[0] === undefined) {
    return undefined;
  }
  return asNode(asNode(targets[0])?.["ResTarget"])?.["val"];
}

export function isAuthUid(value: unknown): boolean {
  const inner = scalarSubselect(value);
  if (inner !== undefined) {
    return isAuthUid(inner);
  }
  const name = funcName(value);
  return (
    name === "auth.uid" ||
    name === "auth.user_id" ||
    name === "uid" ||
    name === "user_id" ||
    name?.split(".").at(-1) === USER_ID_HELPER
  );
}

export function isCurrentSettingUserId(value: unknown): boolean {
  const inner = scalarSubselect(value);
  if (inner !== undefined) {
    return isCurrentSettingUserId(inner);
  }
  const name = funcName(value);
  if (name !== "current_setting") {
    return false;
  }
  const node = asNode(unwrap(value));
  const args = asNode(node?.["FuncCall"])?.["args"];
  if (!Array.isArray(args) || args[0] === undefined) {
    return false;
  }
  const literal = constValue(args[0]);
  return typeof literal === "string" && literal.endsWith(".user_id");
}

export function constValue(value: unknown): ConditionValue | undefined {
  const node = asNode(unwrap(value));
  const constant = asNode(node?.["A_Const"]);
  if (constant === undefined) {
    return undefined;
  }
  if (constant["isnull"] === true) {
    return null;
  }
  const sval = asNode(constant["sval"]);
  if (sval !== undefined && typeof sval["sval"] === "string") {
    return sval["sval"];
  }
  if (typeof constant["sval"] === "string") {
    return constant["sval"];
  }
  // The parser omits a protobuf default, so `0` and `false` arrive as `{}`.
  const ival = asNode(constant["ival"]);
  if (ival !== undefined) {
    const number = ival["ival"] ?? 0;
    return typeof number === "number" ? number : undefined;
  }
  if (typeof constant["ival"] === "number") {
    return constant["ival"];
  }
  const boolval = asNode(constant["boolval"]);
  if (boolval !== undefined) {
    const flag = boolval["boolval"] ?? false;
    return typeof flag === "boolean" ? flag : undefined;
  }
  if (typeof constant["boolval"] === "boolean") {
    return constant["boolval"];
  }
  return undefined;
}

function selectFromTable(selectNode: unknown): string | undefined {
  const select = asNode(asNode(selectNode)?.["SelectStmt"]);
  const from = select?.["fromClause"];
  if (!Array.isArray(from) || from[0] === undefined) {
    return undefined;
  }
  const range = asNode(asNode(from[0])?.["RangeVar"]);
  const relname = range?.["relname"];
  return typeof relname === "string" ? relname : undefined;
}

function sublinkTable(
  value: unknown,
  kinds: ReadonlySet<string | number>,
): string | undefined {
  const node = asNode(unwrap(value));
  const sub = asNode(node?.["SubLink"]);
  if (sub === undefined) {
    return undefined;
  }
  const kind = sub["subLinkType"];
  // SAFETY: Set.has only compares by identity, so a kind of any other type just misses.
  if (kind === undefined || !kinds.has(kind as string | number)) {
    return undefined;
  }
  return selectFromTable(sub["subselect"]);
}

export function membershipTable(value: unknown): string | undefined {
  const exists = sublinkTable(value, new Set(["EXISTS_SUBLINK", 0]));
  if (exists !== undefined) {
    return exists;
  }
  const anyDirect = sublinkTable(
    value,
    new Set(["ANY_SUBLINK", "IN_SUBLINK", 2]),
  );
  if (anyDirect !== undefined) {
    return anyDirect;
  }
  const node = asNode(unwrap(value));
  const expr = asNode(node?.["A_Expr"]);
  if (expr === undefined) {
    return undefined;
  }
  const right = unwrap(expr["rexpr"]);
  const fromRight = sublinkTable(
    right,
    new Set(["ANY_SUBLINK", "IN_SUBLINK", "EXISTS_SUBLINK", 0, 2]),
  );
  if (fromRight !== undefined) {
    return fromRight;
  }
  if (Array.isArray(expr["rexpr"]) && expr["rexpr"][0] !== undefined) {
    return selectFromTable(expr["rexpr"][0]);
  }
  return undefined;
}

export function operatorName(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const expr = asNode(node?.["A_Expr"]);
  const names = expr?.["name"];
  if (!Array.isArray(names) || names[0] === undefined) {
    return undefined;
  }
  return stringVal(names[0]);
}

export function boolOp(value: unknown): "and" | "or" | "not" | undefined {
  const node = asNode(unwrap(value));
  const expr = asNode(node?.["BoolExpr"]);
  const op = expr?.["boolop"];
  if (op === "AND_EXPR" || op === 0) {
    return "and";
  }
  if (op === "OR_EXPR" || op === 1) {
    return "or";
  }
  if (op === "NOT_EXPR" || op === 2) {
    return "not";
  }
  return undefined;
}

export function functionLookupName(
  name: string,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
): RlsFunctionMapping | undefined {
  if (functions === undefined) {
    return undefined;
  }
  if (functions[name] !== undefined) {
    return functions[name];
  }
  const short = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1)
    : name;
  return functions[short];
}

export function argFromNode(value: unknown): SqlFunctionArg | undefined {
  const field = columnName(value);
  if (field !== undefined) {
    return { field };
  }
  if (isAuthUid(value) || isCurrentSettingUserId(value)) {
    return { ref: "principal.id" };
  }
  return constValue(value);
}

export async function canonicalDump(sql: string): Promise<string | undefined> {
  try {
    return await deparse(await parse(sql));
  } catch {
    return undefined;
  }
}

export function asStmts(parsed: unknown): readonly unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  const node = asNode(parsed);
  if (Array.isArray(node?.["stmts"])) {
    return node["stmts"];
  }
  return [];
}

export async function fingerprintSql(sql: string): Promise<string> {
  try {
    const parsed = await parse(`SELECT 1 WHERE (${sql})`);
    const deparsed = await deparse(parsed);
    return createHash("sha256").update(deparsed).digest("hex").slice(0, 16);
  } catch {
    return createHash("sha256")
      .update(sql.replaceAll(/\s+/g, " ").trim().toLowerCase())
      .digest("hex")
      .slice(0, 16);
  }
}

export function nodeStmt(first: PgNode | undefined): unknown {
  const raw = asNode(first?.["RawStmt"]);
  if (raw !== undefined) {
    return raw["stmt"];
  }
  return first?.["stmt"];
}

export function jwtClaim(value: unknown): string | undefined {
  const node = asNode(unwrap(value));
  const expr = asNode(node?.["A_Expr"]);
  if (expr === undefined) {
    return undefined;
  }
  const name = operatorName(node);
  if ((name !== "->>" && name !== "->") || !isJwtCall(expr["lexpr"])) {
    return undefined;
  }
  const claim = constValue(expr["rexpr"]);
  return typeof claim === "string" ? claim : undefined;
}

/** `auth.jwt()` / `auth.session()`, bare or as a scalar `(select …)`; a column's `->>` is row data, not a claim. */
function isJwtCall(value: unknown): boolean {
  const inner = scalarSubselect(value);
  if (inner !== undefined) {
    return isJwtCall(inner);
  }
  const name = funcName(value);
  return name === "auth.jwt" || name === "auth.session";
}
