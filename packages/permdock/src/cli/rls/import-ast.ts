import { createHash } from "node:crypto";
import { parse } from "pgsql-parser";

import type { Condition, SqlFunctionArg } from "../../index.ts";
import type {
  RlsFunctionMapping,
  RlsMembershipTable,
  RlsMemberships,
} from "../types.ts";
import type { HelperScope, RolePermission } from "./helpers.ts";

import { quoteSqlLiteral } from "../../core/sql.ts";
import { HELPERS } from "../sql/shared.ts";
import { SESSION_LIVE_HELPER } from "../sql/subject.ts";
import { membershipRoles } from "./import-membership.ts";
import {
  argFromNode,
  asNode,
  asStmts,
  boolOp,
  columnName,
  constValue,
  fingerprintSql,
  funcName,
  functionLookupName,
  isAuthUid,
  isCurrentSettingUserId,
  jwtClaim,
  membershipSubquery,
  nodeStmt,
  operatorName,
  scalarSubselect,
  unwrap,
} from "./import-nodes.ts";

export async function conditionFromAst(
  sql: string | undefined,
  memberships: RlsMemberships | undefined,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
  unmapped: string[],
  joins: string[] = [],
  seeds: readonly RolePermission[] = [],
): Promise<unknown> {
  if (sql === undefined || sql.trim() === "" || sql.trim() === "true") {
    return { op: "eq", field: "_", value: true };
  }
  const where = await whereOf(sql);
  if (where === undefined) {
    return { op: "opaque", sql, fingerprint: await fingerprintSql(sql) };
  }
  const mapped = mapNode(where, {
    memberships,
    functions,
    unmapped,
    joins,
    seeds,
  });
  if (mapped === undefined) {
    return { op: "opaque", sql, fingerprint: await fingerprintSql(sql) };
  }
  return mapped;
}

async function whereOf(sql: string): Promise<unknown> {
  try {
    const parsed = await parse(`SELECT 1 WHERE (${sql})`);
    const first = asNode(asStmts(parsed)[0]);
    const raw = asNode(nodeStmt(first));
    return asNode(raw?.["SelectStmt"])?.["whereClause"];
  } catch {
    return undefined;
  }
}

type MapContext = {
  readonly memberships: RlsMemberships | undefined;
  readonly functions: Readonly<Record<string, RlsFunctionMapping>> | undefined;
  readonly unmapped: string[];
  readonly joins: string[];
  readonly seeds: readonly RolePermission[];
};

/**
 * A call to one of the generated RLS helpers (`permdock_has`,
 * `permitted_<scope>_ids`), in either policy shape.
 */
export type HelperCall = {
  readonly scope: HelperScope;
  readonly key: string;
  readonly column?: string;
};

const PERMITTED = /^permitted_([a-z][a-z0-9_]*)_ids$/u;

function helperScope(name: string | undefined): HelperScope | undefined {
  if (name === undefined) {
    return undefined;
  }
  const bare = name.slice(name.lastIndexOf(".") + 1);
  if (bare === HELPERS.has) {
    return "global";
  }
  return PERMITTED.exec(bare)?.[1];
}

function helperKey(call: unknown): string | undefined {
  const args = asNode(asNode(unwrap(call))?.["FuncCall"])?.["args"];
  if (!Array.isArray(args) || args.length !== 1) {
    return undefined;
  }
  const key = constValue(args[0]);
  return typeof key === "string" ? key : undefined;
}

function helperCall(value: unknown): HelperCall | undefined {
  const node = asNode(unwrap(value));
  const sub = asNode(node?.["SubLink"]);
  if (sub === undefined) {
    const scope = helperScope(funcName(node));
    const key = helperKey(node);
    return scope === "global" && key !== undefined ? { scope, key } : undefined;
  }
  const targets = asNode(asNode(sub["subselect"])?.["SelectStmt"])?.[
    "targetList"
  ];
  if (!Array.isArray(targets) || targets.length !== 1) {
    return undefined;
  }
  const call = asNode(asNode(targets[0])?.["ResTarget"])?.["val"];
  const scope = helperScope(funcName(call));
  const key = helperKey(call);
  if (scope === undefined || key === undefined) {
    return undefined;
  }
  const kind = sub["subLinkType"];
  if (scope === "global") {
    return kind === "EXPR_SUBLINK" || kind === 4 ? { scope, key } : undefined;
  }
  const column = columnName(sub["testexpr"]);
  return (kind === "ANY_SUBLINK" || kind === 2) && column !== undefined
    ? { scope, key, column }
    : undefined;
}

const MEMBER = /^member_([a-z][a-z0-9_]*)_ids$/u;

/**
 * `col in (select member_<scope>_ids())`: any live membership of the row's
 * instance.
 */
function memberCall(
  value: unknown,
): { readonly scope: string; readonly column: string } | undefined {
  const sub = asNode(asNode(unwrap(value))?.["SubLink"]);
  const kind = sub?.["subLinkType"];
  if (sub === undefined || (kind !== "ANY_SUBLINK" && kind !== 2)) {
    return undefined;
  }
  const targets = asNode(asNode(sub["subselect"])?.["SelectStmt"])?.[
    "targetList"
  ];
  if (!Array.isArray(targets) || targets.length !== 1) {
    return undefined;
  }
  const call = asNode(asNode(targets[0])?.["ResTarget"])?.["val"];
  const name = funcName(asNode(unwrap(call)));
  const args = asNode(asNode(unwrap(call))?.["FuncCall"])?.["args"];
  const scope =
    name === undefined
      ? undefined
      : MEMBER.exec(name.slice(name.lastIndexOf(".") + 1))?.[1];
  const column = columnName(sub["testexpr"]);
  return scope === undefined ||
    column === undefined ||
    (Array.isArray(args) && args.length > 0)
    ? undefined
    : { scope, column };
}

function rolesFor(
  seeds: readonly RolePermission[],
  key: string,
  scope: HelperScope,
): readonly string[] {
  return [
    ...new Set(
      seeds
        .filter((seed) => seed.grantKey === key && seed.scope === scope)
        .map((seed) => seed.role),
    ),
  ];
}

function helperCondition(
  call: HelperCall,
  seeds: readonly RolePermission[],
): Condition {
  const roles = rolesFor(seeds, call.key, call.scope);
  if (call.scope === "global" || call.column === undefined) {
    // A global role has no row form: keep it verbatim, and name its roles in `grants`.
    const sql = `(select ${HELPERS.has}(${quoteSqlLiteral(call.key)}))`;
    return {
      op: "opaque",
      sql,
      fingerprint: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    };
  }
  return {
    op: "memberOf",
    scope: call.scope,
    field: call.column,
    roles: [...roles],
  };
}

/**
 * One role-gated branch of an imported policy: which roles, at which scope,
 * under which row condition.
 */
export type ImportedGrant = {
  readonly key: string;
  readonly permission: string;
  readonly scope: HelperScope;
  readonly roles: readonly string[];
  readonly where?: Condition;
};

function flatten(value: unknown, op: "and" | "or"): readonly unknown[] {
  if (boolOp(value) !== op) {
    return [value];
  }
  const args = asNode(asNode(unwrap(value))?.["BoolExpr"])?.["args"];
  return Array.isArray(args) ? args.flatMap((arg) => flatten(arg, op)) : [];
}

function helperCalls(conjunct: unknown): readonly HelperCall[] | undefined {
  const calls = flatten(conjunct, "or").map(helperCall);
  // SAFETY: every() above checked that no call is undefined.
  return calls.every((call) => call !== undefined)
    ? (calls as readonly HelperCall[])
    : undefined;
}

/**
 * The role structure of a policy that calls the helpers: each OR branch's
 * helper calls become grants (roles from the `role_permissions` seeds), the
 * branch's other conjuncts become their `where`. Restrictive policies are read
 * through their outer `not`.
 */
export async function helperGrants(
  sql: string | undefined,
  memberships: RlsMemberships | undefined,
  functions: Readonly<Record<string, RlsFunctionMapping>> | undefined,
  seeds: readonly RolePermission[],
): Promise<readonly ImportedGrant[]> {
  if (sql === undefined) {
    return [];
  }
  let where = await whereOf(sql);
  if (boolOp(where) === "not") {
    where = asNode(asNode(unwrap(where))?.["BoolExpr"])?.["args"];
    where = Array.isArray(where) ? where[0] : undefined;
  }
  const unportable: Condition = {
    op: "opaque",
    sql,
    fingerprint: await fingerprintSql(sql),
  };
  const grants: ImportedGrant[] = [];
  for (const branch of flatten(where, "or")) {
    const conjuncts = flatten(branch, "and");
    const calls: HelperCall[] = [];
    const rest: Condition[] = [];
    let portable = true;
    for (const conjunct of conjuncts) {
      const found = helperCalls(conjunct);
      if (found !== undefined) {
        calls.push(...found);
        continue;
      }
      const mapped = mapNode(conjunct, {
        memberships,
        functions,
        unmapped: [],
        joins: [],
        seeds,
      });
      if (mapped === undefined) {
        portable = false;
      } else {
        rest.push(mapped);
      }
    }
    if (calls.length === 0) {
      continue;
    }
    const condition: Condition | undefined = portable
      ? rest.length === 0
        ? undefined
        : rest.length === 1
          ? rest[0]
          : { op: "and", conditions: rest }
      : unportable;
    for (const call of calls) {
      const permission =
        seeds.find((seed) => seed.grantKey === call.key)?.permission ??
        call.key.replace(/#[a-z0-9][a-z0-9_-]*$/u, "");
      grants.push({
        key: call.key,
        permission,
        scope: call.scope,
        roles: rolesFor(seeds, call.key, call.scope),
        ...(condition === undefined ? {} : { where: condition }),
      });
    }
  }
  return grants;
}

function mapNode(value: unknown, ctx: MapContext): Condition | undefined {
  if (value === undefined) {
    return undefined;
  }
  const node = asNode(unwrap(value));
  if (node === undefined) {
    return undefined;
  }
  const { memberships, functions, unmapped, joins } = ctx;
  const member = memberCall(node);
  if (member !== undefined) {
    return {
      op: "memberOf",
      scope: member.scope,
      field: member.column,
      roles: [],
    };
  }
  const helper = helperCall(node);
  if (helper !== undefined) {
    return helperCondition(helper, ctx.seeds);
  }
  if (
    funcName(scalarSubselect(node) ?? node)
      ?.split(".")
      .at(-1) === SESSION_LIVE_HELPER
  ) {
    return { op: "liveSession" };
  }
  const nullTest = asNode(node["NullTest"]);
  if (nullTest !== undefined) {
    const field = columnName(nullTest["arg"]);
    if (field === undefined) {
      return undefined;
    }
    const isNull =
      nullTest["nulltesttype"] === "IS_NULL" ||
      nullTest["nulltesttype"] === 0 ||
      nullTest["nulltesttype"] === undefined;
    return { op: "isNull", field, value: isNull };
  }
  const compound = boolOp(node);
  if (compound !== undefined) {
    const expr = asNode(node["BoolExpr"]);
    const args = expr?.["args"];
    if (!Array.isArray(args)) {
      return undefined;
    }
    if (compound === "not") {
      const inner = mapNode(args[0], ctx);
      return inner === undefined ? undefined : { op: "not", condition: inner };
    }
    const children = args
      .map((arg) => mapNode(arg, ctx))
      .filter((item): item is Condition => item !== undefined);
    if (children.length !== args.length) {
      return undefined;
    }
    return { op: compound, conditions: children };
  }
  const subquery = membershipSubquery(node);
  if (subquery !== undefined) {
    const { table } = subquery;
    const mappedScopes: [string, RlsMembershipTable][] = Object.entries(
      memberships?.scopes ?? {},
    );
    const matches = mappedScopes.filter(([, mapped]) => mapped.table === table);
    if (matches.length > 0) {
      // A mapped membership table imports as memberOf only when its where
      // binds the user and the row and filters roles by literal: anything
      // else stays opaque instead of widening to "any member".
      for (const [scope, mapped] of matches) {
        const read = membershipRoles(subquery, mapped);
        if (read !== undefined) {
          return {
            op: "memberOf",
            scope,
            field: read.field,
            roles: read.roles,
          };
        }
      }
      return undefined;
    }
    joins.push(table);
    return undefined;
  }
  const name = funcName(node);
  if (name !== undefined && !isAuthUid(node) && name !== "current_setting") {
    const mapping = functionLookupName(name, functions);
    if (mapping === undefined) {
      unmapped.push(name);
      return undefined;
    }
    const call = asNode(node["FuncCall"]);
    const rawArgs = Array.isArray(call?.["args"]) ? call["args"] : [];
    const args: SqlFunctionArg[] =
      mapping.args?.map((field) => ({ field })) ??
      rawArgs
        .map((arg) => argFromNode(arg))
        .filter((item): item is SqlFunctionArg => item !== undefined);
    // SAFETY: twin comes from the project's own rls.functions config, which documents it as a Condition.
    return { op: "sqlFunction", name, args, twin: mapping.twin as Condition };
  }
  const op = operatorName(node);
  const expr = asNode(node["A_Expr"]);
  if (
    op === "=" ||
    op === "<>" ||
    op === ">" ||
    op === ">=" ||
    op === "<" ||
    op === "<="
  ) {
    const left = columnName(expr?.["lexpr"]) ?? columnName(expr?.["rexpr"]);
    const right = expr?.["lexpr"];
    const leftIsColumn = columnName(expr?.["lexpr"]) !== undefined;
    const other = leftIsColumn ? expr?.["rexpr"] : right;
    if (left === undefined) {
      return undefined;
    }
    const comparison =
      op === "="
        ? "eq"
        : op === "<>"
          ? "ne"
          : op === ">"
            ? "gt"
            : op === ">="
              ? "gte"
              : op === "<"
                ? "lt"
                : "lte";
    if (isAuthUid(other) || isCurrentSettingUserId(other)) {
      return { op: comparison, field: left, value: { ref: "principal.id" } };
    }
    const literal = constValue(other);
    if (literal === undefined) {
      const claim = jwtClaim(other);
      if (claim !== undefined) {
        return {
          op: comparison,
          field: left,
          value: { ref: `principal.claim.${claim}` },
        };
      }
      return undefined;
    }
    return { op: comparison, field: left, value: literal };
  }
  return undefined;
}
