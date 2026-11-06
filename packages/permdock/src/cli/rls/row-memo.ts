import type { Policy } from "../../index.ts";
import type { RlsSqlContext } from "../sql/context.ts";

import { scopeTypeOf } from "../sql/columns.ts";
import {
  graphHelper,
  memberIdsHelper,
  permittedIdsHelper,
} from "../sql/names.ts";
import { helperSchema, quoteLiteral } from "../sql/quote.ts";
import { HELPERS } from "../sql/shared.ts";
import { subjectIdSql, USER_ID_HELPER } from "../sql/subject.ts";
import { API_KEY_ALLOWS } from "./api-keys.ts";
import { graphIdsSql, graphPlan } from "./graph.ts";
import {
  memoDiscriminatorSql,
  memoReadSql,
  memoizes,
} from "./helper-bodies.ts";
import { memoReadsSql } from "./helpers.ts";
import { memoReadTriggersSql } from "./memo-generation.ts";
import {
  PERMISSION_HELPERS,
  permittedByPermissionHelper,
} from "./permission-keys.ts";
import { TOKEN_SCOPE_ALLOWS } from "./token-scopes.ts";

const TERMS = "v_permdock_terms";
const CANDIDATES = "permdock_candidates";
const PAIRS = 50;

type Call = {
  readonly schema: string;
  readonly name: string;
  readonly end: number;
};

type Slot = { readonly key: string; readonly value: string };

const IDENT = /"(?:[^"]|"")+"|[a-z_][a-z0-9_]*/uy;
const WORD = /true\b|false\b|null\b|-?\d+(?:\.\d+)?/uy;
const CAST = /::[a-z_][a-z0-9_]*/uy;
const SET_BEFORE = /\b(?:in|array|any|all|some)\s*$/u;
const EXISTS_BEFORE = /\bexists\s*$/u;

function sticky(
  pattern: RegExp,
  sql: string,
  at: number,
): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(sql);
}

function spaces(sql: string, at: number): number {
  let index = at;
  while (sql[index] === " " || sql[index] === "\n") {
    index += 1;
  }
  return index;
}

function literalEnd(sql: string, at: number, quote: string): number {
  let index = at + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] !== quote) {
        return index + 1;
      }
      index += 1;
    }
    index += 1;
  }
  return sql.length;
}

function identAt(
  sql: string,
  at: number,
): { readonly name: string; readonly end: number } | undefined {
  const match = sticky(IDENT, sql, at);
  if (match === null) {
    return undefined;
  }
  const [text] = match;
  return {
    name: text.startsWith('"') ? text.slice(1, -1).replaceAll('""', '"') : text,
    end: at + text.length,
  };
}

function argEnd(sql: string, at: number): number | undefined {
  if (sql[at] === "'") {
    const end = literalEnd(sql, at, "'");
    const cast = sticky(CAST, sql, end);
    return cast === null ? end : end + cast[0].length;
  }
  if (sql.startsWith("array(", at)) {
    const term = termAt(sql, at + 5);
    return term?.end;
  }
  const word = sticky(WORD, sql, at);
  return word === null ? undefined : at + word[0].length;
}

function callAt(sql: string, at: number): Call | undefined {
  const schema = identAt(sql, at);
  if (schema === undefined || sql[schema.end] !== ".") {
    return undefined;
  }
  const name = identAt(sql, schema.end + 1);
  if (name === undefined || sql[name.end] !== "(") {
    return undefined;
  }
  let index = spaces(sql, name.end + 1);
  if (sql[index] === ")") {
    return { schema: schema.name, name: name.name, end: index + 1 };
  }
  for (;;) {
    const end = argEnd(sql, index);
    if (end === undefined) {
      return undefined;
    }
    index = spaces(sql, end);
    if (sql[index] === ")") {
      return { schema: schema.name, name: name.name, end: index + 1 };
    }
    if (sql[index] !== ",") {
      return undefined;
    }
    index = spaces(sql, index + 1);
  }
}

function termAt(sql: string, at: number): Call | undefined {
  if (!sql.startsWith("(select ", at)) {
    return undefined;
  }
  const call = callAt(sql, at + 8);
  if (call === undefined || sql[call.end] !== ")") {
    return undefined;
  }
  return { ...call, end: call.end + 1 };
}

function memoTypes(
  ctx: RlsSqlContext,
  policy: Policy,
): ReadonlyMap<string, string> {
  const types = new Map<string, string>([
    [USER_ID_HELPER, "uuid"],
    [HELPERS.has, "boolean"],
    [PERMISSION_HELPERS.has, "boolean"],
    [API_KEY_ALLOWS, "boolean"],
    [TOKEN_SCOPE_ALLOWS, "boolean"],
  ]);
  for (const name of graphPlan(policy).keys()) {
    types.set(graphHelper(name), "text");
  }
  for (const scope of ctx.scopes) {
    const type = scopeTypeOf(ctx, scope.name);
    types.set(permittedIdsHelper(scope.name), type);
    types.set(permittedByPermissionHelper(scope.name), type);
    types.set(memberIdsHelper(scope.name), type);
  }
  return types;
}

function rewrite(
  sql: string,
  schema: string,
  types: ReadonlyMap<string, string>,
  terms: Map<string, Slot>,
): { readonly sql: string; readonly used: readonly Slot[] } {
  const used = new Set<Slot>();
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (char === "'" || char === '"') {
      const end = literalEnd(sql, index, char);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    const term = char === "(" ? termAt(sql, index) : undefined;
    const type =
      term === undefined || term.schema !== schema
        ? undefined
        : types.get(term.name);
    const before = type === undefined ? "" : sql.slice(0, index);
    if (
      term === undefined ||
      type === undefined ||
      EXISTS_BEFORE.test(before)
    ) {
      out += char;
      index += 1;
      continue;
    }
    const text = sql.slice(index, term.end);
    const set = SET_BEFORE.test(before);
    const id = `${set ? "s" : "v"}${text}`;
    const slot = terms.get(id) ?? {
      key: quoteLiteral(`t${String(terms.size)}`),
      value: set ? `array${text}` : text,
    };
    terms.set(id, slot);
    used.add(slot);
    out += set
      ? `(select pdm.v::${type} from pg_catalog.jsonb_array_elements_text(${TERMS} -> ${slot.key}) pdm(v))`
      : `((${TERMS} ->> ${slot.key})::${type})`;
    index = term.end;
  }
  return { sql: out, used: [...used] };
}

function computeSql(used: readonly Slot[]): string {
  const pairs = used.map((slot) => `${slot.key}, to_jsonb(${slot.value})`);
  const chunks: string[] = [];
  for (let at = 0; at < pairs.length; at += PAIRS) {
    chunks.push(
      `jsonb_build_object(${pairs.slice(at, at + PAIRS).join(", ")})`,
    );
  }
  return chunks.join(" || ");
}

export type RowArm = { readonly key: string; readonly sql: string };

export function memoRowSql(
  ctx: RlsSqlContext,
  policy: Policy,
  fn: string,
  params: string,
  resource: string,
  arms: readonly RowArm[],
  candidates: string,
): string | undefined {
  if (!memoizes(ctx)) {
    return undefined;
  }
  const types = memoTypes(ctx, policy);
  const terms = new Map<string, Slot>();
  const rewritten = arms.map((arm) => ({
    key: arm.key,
    ...rewrite(arm.sql, helperSchema(ctx), types, terms),
  }));
  if (terms.size === 0) {
    return undefined;
  }
  const computed = rewritten
    .filter((arm) => arm.used.length > 0)
    .map(
      (arm) =>
        `      when ${quoteLiteral(arm.key)} then ${computeSql(arm.used)}`,
    );
  const where = `case p_permission\n${rewritten.map((arm) => arm.sql).join("\n")}\n    else false\n  end`;
  return `create or replace function ${fn}(${params}, p_permission text)
returns boolean
language plpgsql
stable
security definer
cost 1000
set search_path = ''
as $$
declare
  v_permdock_key text := 'permdock.m.' || ${quoteLiteral(resource)} || '.r' || (hashtext(p_permission) & 1023)::text;
  v_permdock_disc text := ${memoDiscriminatorSql(`${subjectIdSql(ctx)}::text`, "p_permission")};
  v_permdock_memo jsonb := ${memoReadSql(ctx.memo, "v_permdock_key")}::jsonb;
  ${TERMS} jsonb;
begin
  if v_permdock_memo is not null and (v_permdock_memo ->> 'k') = v_permdock_disc then
    ${TERMS} := v_permdock_memo -> 'v';
  else
    ${TERMS} := case p_permission
${computed.join("\n")}
      else '{}'::jsonb
    end;
  end if;
  return exists (
    with ${candidates}
    select 1 from ${CANDIDATES} where ${where}
  );
end;
$$;`;
}

export function memoRowTriggersSql(
  ctx: RlsSqlContext,
  policy: Policy,
  tables: Readonly<Record<string, string>> | undefined,
): string {
  const plan = graphPlan(policy);
  if (!memoizes(ctx) || plan.size === 0) {
    return "";
  }
  return memoReadTriggersSql(
    ctx,
    graphIdsSql(ctx, plan, tables),
    memoReadsSql(ctx),
  );
}
