import { readFileSync } from "node:fs";

import type {
  SupabaseManifest,
  SupabaseManifestSharedFunction,
  SupabaseManifestTableRead,
  SupabaseManifestTenantHelper,
} from "../../supabase/manifest.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import {
  SqlSyntaxError,
  parseSqlFile,
  sqlCalls,
  stringValues,
} from "../sql/ast.ts";
import { reportFiles } from "./report.ts";

type Definition = {
  readonly schema: string;
  readonly name: string;
  readonly body: string;
  readonly eligible: boolean;
  /** The language, security and volatility the definition states. */
  readonly header: string;
};

/** Functions that read who is asking, so the result differs per caller. */
const IDENTITY_FUNCTIONS: ReadonlySet<string> = new Set([
  "current_setting",
  "current_user_id",
  "permdock_user_id",
  "permdock_subject",
  "uid",
  "jwt",
  "role",
  "email",
]);

/** `SQLValueFunction` ops that name the caller. */
const IDENTITY_VALUES: ReadonlySet<string> = new Set([
  "SVFOP_CURRENT_USER",
  "SVFOP_SESSION_USER",
  "SVFOP_USER",
  "SVFOP_CURRENT_ROLE",
]);

const DEFAULT_SCHEMA = "public";

function defElems(node: Readonly<Record<string, unknown>>): {
  readonly [name: string]: unknown;
} {
  const options = Array.isArray(node["options"]) ? node["options"] : [];
  const found: Record<string, unknown> = {};
  for (const option of options) {
    const def: unknown = isRecord(option) ? option["DefElem"] : undefined;
    if (isRecord(def) && typeof def["defname"] === "string") {
      found[def["defname"]] = def["arg"];
    }
  }
  return found;
}

function sval(arg: unknown): string | undefined {
  const text: unknown = isRecord(arg) ? arg["String"] : undefined;
  return isRecord(text) && typeof text["sval"] === "string"
    ? text["sval"].toLowerCase()
    : undefined;
}

function bodyOf(arg: unknown): string {
  const list: unknown = isRecord(arg) ? arg["List"] : undefined;
  return stringValues(isRecord(list) ? list["items"] : []).join("");
}

/** Every value stored under `key` anywhere inside `value`. */
function collect(value: unknown, key: string): readonly unknown[] {
  const out: unknown[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }
      return;
    }
    if (!isRecord(item)) {
      return;
    }
    for (const [name, child] of Object.entries(item)) {
      if (name === key) {
        out.push(child);
      }
      visit(child);
    }
  };
  visit(value);
  return out;
}

/**
 * Whether `node` is a `language sql`, `security invoker`, `stable` or
 * `immutable` function with a body libpg_query parses; `volatile` is the
 * default, so a function that states nothing is not eligible.
 */
function definitionOf(
  node: Readonly<Record<string, unknown>>,
): Definition | undefined {
  const parts = stringValues(node["funcname"]);
  const name = parts.at(-1);
  if (name === undefined) {
    return undefined;
  }
  const schema =
    (parts.length > 1 ? parts[0] : DEFAULT_SCHEMA) ?? DEFAULT_SCHEMA;
  const defs = defElems(node);
  const security: unknown = defs["security"];
  const definer = isRecord(security)
    ? isRecord(security["Boolean"]) && security["Boolean"]["boolval"] === true
    : false;
  const volatility = sval(defs["volatility"]);
  const language = sval(defs["language"]);
  return {
    schema: schema.toLowerCase(),
    name: name.toLowerCase(),
    body: bodyOf(defs["as"]),
    header: `language ${language ?? "unstated"}, security ${definer ? "definer" : "invoker"}, ${volatility ?? "volatile"}`,
    eligible:
      sval(defs["language"]) === "sql" &&
      !definer &&
      (volatility === "stable" || volatility === "immutable"),
  };
}

type Reads = {
  readonly tables: ReadonlySet<string>;
  readonly calls: ReadonlySet<string>;
};

/**
 * The tables a body reads and the functions it calls, or why it is not shared:
 * it reads the caller, calls a function outside `known`, or reads a relation
 * that is not a table in `reads`.
 */
async function readsOf(
  definition: Definition,
  defined: ReadonlyMap<string, readonly Definition[]>,
  reads: ReadonlyMap<string, SupabaseManifestTableRead>,
  helperSchema: string,
): Promise<Reads | string> {
  let statements: Awaited<ReturnType<typeof parseSqlFile>>;
  try {
    statements = await parseSqlFile(definition.body);
  } catch (error) {
    if (error instanceof SqlSyntaxError) {
      return "the body does not parse";
    }
    throw error;
  }
  const tables = new Set<string>();
  const calls = new Set<string>();
  for (const statement of statements) {
    if (statement.kind !== "SelectStmt") {
      return `the body holds a ${statement.kind}, not a select`;
    }
    if (
      collect(statement.node, "SQLValueFunction").some(
        (value) =>
          isRecord(value) &&
          typeof value["op"] === "string" &&
          IDENTITY_VALUES.has(value["op"]),
      )
    ) {
      return "it reads current_user, session_user or user";
    }
    const ctes = new Set(
      collect(statement.node, "CommonTableExpr").flatMap((value) =>
        isRecord(value) && typeof value["ctename"] === "string"
          ? [value["ctename"].toLowerCase()]
          : [],
      ),
    );
    for (const value of collect(statement.node, "RangeVar")) {
      if (!isRecord(value) || typeof value["relname"] !== "string") {
        return "it reads a relation inspect cannot name";
      }
      const relname = value["relname"].toLowerCase();
      const explicit =
        typeof value["schemaname"] === "string"
          ? value["schemaname"].toLowerCase()
          : undefined;
      if (explicit === undefined && ctes.has(relname)) {
        continue;
      }
      const candidates = (
        explicit === undefined
          ? [definition.schema, DEFAULT_SCHEMA]
          : [explicit]
      ).map((schema) => `${schema}.${relname}`);
      const found = candidates.find((table) => reads.has(table));
      if (found === undefined) {
        return `it reads ${candidates[0] ?? relname}, which is no table the schema files create`;
      }
      tables.add(found);
    }
    for (const call of sqlCalls(statement.node)) {
      const last = call.name.at(-1);
      const schema = call.name.length > 1 ? call.name[0] : undefined;
      if (
        last === undefined ||
        IDENTITY_FUNCTIONS.has(last) ||
        schema === "auth"
      ) {
        return `it reads the caller through ${call.name.join(".")}()`;
      }
      if (schema === helperSchema) {
        return `it calls the helper ${call.name.join(".")}(), which is not a permissionFilters helper`;
      }
      const target = (
        schema === undefined
          ? [`${definition.schema}.${last}`, `${DEFAULT_SCHEMA}.${last}`]
          : [`${schema}.${last}`]
      ).find((name) => defined.has(name));
      if (target !== undefined) {
        calls.add(target);
      } else if (schema !== undefined && schema !== "pg_catalog") {
        return `it calls ${call.name.join(".")}(), which no schema file defines`;
      }
    }
  }
  return { tables, calls };
}

/** Why `definition` fails the header checks, or `undefined`. */
function headerReason(definition: Definition): string | undefined {
  return definition.eligible
    ? undefined
    : `it is not language sql, security invoker and stable or immutable (${definition.header})`;
}

/**
 * `rls.sharedFunctions`: the functions better-supabase's doctor BS430 accepts
 * in a `share: "tenant"` fill, read from the same SQL files as `tableReads`. A
 * function is listed when it is `language sql`, `security invoker` and `stable`
 * or `immutable`, parses, reads the caller through neither `auth.*`,
 * `current_user`, `current_setting` nor a helper of the `helperSchema`, calls
 * only other listed functions or built-ins, and reads only tables that
 * `tableReads` marks `tenant`. An overloaded name is listed when every overload
 * qualifies. A file libpg_query rejects is skipped; the last definition of a
 * function wins.
 */
export async function sharedFunctionsOf(
  input: SharedFunctionsInput,
): Promise<readonly SupabaseManifestSharedFunction[]> {
  const outcomes = await analyse(input);
  return [...outcomes.keys()].toSorted().flatMap((name) => {
    const shared = outcomes.get(name)?.shared;
    return shared === undefined ? [] : [shared];
  });
}

type SharedFunctionsInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly schema: string;
  readonly tableReads: readonly SupabaseManifestTableRead[];
};

/** What `permdock supabase inspect --functions` prints for one function. */
export type FunctionShare = {
  /** `schema.name`. */
  readonly function: string;
  readonly shared: boolean;
  /** Every reason the function is not shared; empty when it is. */
  readonly reasons: readonly string[];
};

type Outcome = {
  readonly shared?: SupabaseManifestSharedFunction;
  readonly reasons: readonly string[];
};

/** `*` matches any run of characters, every other character itself. */
function matcher(pattern: string): (name: string) => boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join(".*");
  const regex = new RegExp(`^${source}$`, "u");
  return (name) => regex.test(name);
}

/**
 * For each function the schema files define whose `schema.name` matches
 * `pattern` (`public.*_payload`), a pass or every reason `sharedFunctionsOf`
 * does not list it: a header it fails, a read of the caller, an unknown call,
 * or the `row` table it reads with the rules that make it so.
 */
export async function functionShares(
  input: SharedFunctionsInput,
  pattern: string,
): Promise<readonly FunctionShare[]> {
  const matches = matcher(pattern.toLowerCase());
  const outcomes = await analyse(input);
  return [...outcomes.keys()]
    .filter((name) => matches(name))
    .toSorted()
    .map((name) => {
      const outcome = outcomes.get(name);
      return {
        function: name,
        shared: outcome?.shared !== undefined,
        reasons: outcome?.reasons ?? [],
      };
    });
}

async function analyse(
  input: SharedFunctionsInput,
): Promise<ReadonlyMap<string, Outcome>> {
  const reads = new Map(input.tableReads.map((read) => [read.table, read]));
  const byArity = new Map<string, Definition>();
  for (const file of reportFiles(input.cwd, input.config)) {
    let nodes: Awaited<ReturnType<typeof parseSqlFile>>;
    try {
      nodes = await parseSqlFile(readFileSync(file, "utf8"));
    } catch (error) {
      if (error instanceof SqlSyntaxError) {
        continue;
      }
      throw error;
    }
    for (const node of nodes) {
      if (node.kind !== "CreateFunctionStmt") {
        continue;
      }
      const definition = definitionOf(node.node);
      if (definition === undefined) {
        continue;
      }
      const params = collect(node.node["parameters"], "FunctionParameter")
        .map((value) =>
          isRecord(value) && isRecord(value["argType"])
            ? stringValues(value["argType"]["names"]).join(".")
            : "",
        )
        .join(",");
      byArity.set(
        `${definition.schema}.${definition.name}(${params})`,
        definition,
      );
    }
  }
  const defined = new Map<string, Definition[]>();
  for (const definition of byArity.values()) {
    const key = `${definition.schema}.${definition.name}`;
    defined.set(key, [...(defined.get(key) ?? []), definition]);
  }
  const helperSchema = input.schema.toLowerCase();
  const analysed = new Map<string, Reads>();
  const reasons = new Map<string, string[]>();
  for (const [name, overloads] of defined) {
    const merged: Reads[] = [];
    const why: string[] = [];
    for (const definition of overloads) {
      const found =
        headerReason(definition) ??
        (await readsOf(definition, defined, reads, helperSchema));
      if (typeof found === "string") {
        why.push(found);
      } else {
        merged.push(found);
      }
    }
    reasons.set(name, why);
    if (why.length === 0 && merged.length > 0) {
      analysed.set(name, {
        tables: new Set(merged.flatMap((entry) => [...entry.tables])),
        calls: new Set(merged.flatMap((entry) => [...entry.calls])),
      });
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, entry] of analysed) {
      const gone = [...entry.calls].filter((call) => !analysed.has(call));
      if (gone.length > 0) {
        analysed.delete(name);
        reasons.set(
          name,
          gone.map((call) => `it calls ${call}, which is not shared`),
        );
        changed = true;
      }
    }
  }
  const close = (name: string, seen: Set<string>): void => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    for (const call of analysed.get(name)?.calls ?? []) {
      close(call, seen);
    }
  };
  const outcomes = new Map<string, Outcome>();
  for (const name of defined.keys()) {
    if (!analysed.has(name)) {
      outcomes.set(name, { reasons: reasons.get(name) ?? [] });
      continue;
    }
    const reached = new Set<string>();
    close(name, reached);
    const tables = new Set<string>();
    for (const member of reached) {
      for (const table of analysed.get(member)?.tables ?? []) {
        tables.add(table);
      }
    }
    const rows = [...tables]
      .toSorted()
      .filter((table) => reads.get(table)?.share !== "tenant");
    if (tables.size === 0 || rows.length > 0) {
      outcomes.set(name, {
        reasons:
          tables.size === 0
            ? ["it reads no table"]
            : rows.map((table) => rowReason(table, reads.get(table))),
      });
      continue;
    }
    outcomes.set(name, {
      reasons: [],
      shared: {
        function: name,
        tables: [...tables].toSorted(),
        permissions: [
          ...new Set(
            [...tables].flatMap((table) => reads.get(table)?.permissions ?? []),
          ),
        ].toSorted(),
      },
    });
  }
  return outcomes;
}

/** The `row` table a function reads, under which rule and why. */
function rowReason(
  table: string,
  read: SupabaseManifestTableRead | undefined,
): string {
  const rules = read?.rules?.join(", ") ?? "unknown";
  const why = read?.reason === undefined ? "" : `: ${read.reason}`;
  return `it reads ${table}, a row table (rule ${rules})${why}`;
}

/**
 * `rls.tenantPureHelpers`: the helpers of the root scope that answer from the
 * caller's grants of the passed key in the passed tenant and nothing else, so
 * two callers with an equal `grantFingerprint` for the key get one answer.
 *
 * - `permdock_<root>_has(p_grant, p_tenant)` tests one grant key in one tenant.
 * - `permitted_<root>_permission_keys(p_id, p_keys)` lists which of `p_keys` the
 *   caller holds on one tenant.
 *
 * Every other helper reads grants outside the tenant (`permitted_<root>_ids`,
 * `permitted_<root>_ids_by_permission`, `permitted_<root>_id_array`,
 * `permdock_has`), a decision of one row (`permitted_<resource>_rows`) or the
 * caller (`permdock_subject`, `permdock_bootstrap_permissions`), and is left
 * out. `rls generate` writes both for every scope, so the manifest names them
 * whenever it has an `rls` block.
 */
export function tenantPureHelpersOf(
  manifest: SupabaseManifest,
): readonly SupabaseManifestTenantHelper[] {
  const root = manifest.rls.scopes[0]?.name;
  if (root === undefined) {
    return [];
  }
  const prefix = `permitted_${root}`;
  const candidates = [
    {
      name: `permdock_${root}_has`,
      keyArgument: "p_grant",
      keyPosition: 0,
      tenantArgument: "p_tenant",
    },
    {
      name: `${prefix}_permission_keys`,
      keyArgument: "p_keys",
      keyPosition: 1,
      tenantArgument: "p_id",
    },
  ];
  return candidates.map((candidate) => ({
    ...candidate,
    name: `${manifest.rls.schema}.${candidate.name}`,
  }));
}
