import type { RlsMigrateConfig } from "./types.ts";

import { escapeSqlIdent } from "../core/sql.ts";
import { tableKey } from "./deciding-columns.ts";
import { RETIRE_MARKER } from "./markers.ts";

/** One statement of a migration file, comments blanked. */
export type RetireStatement = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

export type RetireReader = {
  readonly kind: "policy" | "view" | "function";
  readonly name: string;
  readonly file: string;
  readonly line: number;
};

export type RetireTrigger = {
  readonly name: string;
  readonly table: string;
  readonly function: string;
};

/** What `rls migrate` found for one `rls.migrate.tables` entry. */
export type RetireTable = {
  readonly table: string;
  /** Whether the migrations still create it: false once a later file drops it. */
  readonly present: boolean;
  readonly kind: "table" | "materialized view";
  readonly refreshTriggers: readonly RetireTrigger[];
  readonly refreshFunctions: readonly string[];
  /** Policies on other tables, views and functions that still read it. */
  readonly readers: readonly RetireReader[];
};

export type RetirePlan = {
  readonly tables: readonly RetireTable[];
  /** `rls.migrate.helpers` still defined that nothing calls. */
  readonly helpers: readonly string[];
};

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const NAME = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?)`;
const NAMES = String.raw`(${IDENT}(?:\s*\.\s*${IDENT})?(?:\s*,\s*${IDENT}(?:\s*\.\s*${IDENT})?)*)`;

const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}`,
  "iu",
);
const CREATE_MATVIEW = new RegExp(
  String.raw`^create\s+materialized\s+view\s+(?:if\s+not\s+exists\s+)?${NAME}`,
  "iu",
);
const DROP_RELATION = new RegExp(
  String.raw`^drop\s+(table|materialized\s+view|view)\s+(?:if\s+exists\s+)?${NAMES}`,
  "iu",
);
const CREATE_VIEW = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:recursive\s+)?view\s+${NAME}`,
  "iu",
);
const CREATE_FUNCTION = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${NAME}\s*\(`,
  "iu",
);
const DROP_FUNCTION = new RegExp(
  String.raw`^drop\s+(?:function|procedure)\s+(?:if\s+exists\s+)?([\s\S]*)$`,
  "iu",
);
const CREATE_TRIGGER = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+(${IDENT})[\s\S]*?\bon\s+${NAME}[\s\S]*?\bexecute\s+(?:function|procedure)\s+${NAME}\s*\(`,
  "iu",
);
const DROP_TRIGGER = new RegExp(
  String.raw`^drop\s+trigger\s+(?:if\s+exists\s+)?(${IDENT})\s+on\s+${NAME}`,
  "iu",
);
const POLICY = new RegExp(
  String.raw`^(create|alter)\s+policy\s+(${IDENT})\s+on\s+${NAME}`,
  "iu",
);
const DROP_POLICY = new RegExp(
  String.raw`^drop\s+policy\s+(?:if\s+exists\s+)?(${IDENT})\s+on\s+${NAME}`,
  "iu",
);

/** A capture group the pattern always fills. */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function bare(ident: string): string {
  return ident.replaceAll('"', "");
}

function key(name: string): string {
  return tableKey(name.replaceAll(/\s+/gu, ""));
}

function escapeRegex(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** A reference to `schema.name`, qualified or not, outside a longer identifier. */
function refPattern(table: string): string {
  const [schema = "public", name = ""] = table.split(".");
  return String.raw`(?<![\w$."])(?:"?${escapeRegex(schema)}"?\s*\.\s*)?"?${escapeRegex(name)}"?(?![\w$"])`;
}

function writesPattern(table: string): RegExp {
  return new RegExp(
    String.raw`\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|merge\s+into|refresh\s+materialized\s+view(?:\s+concurrently)?)\s+(?:only\s+)?${refPattern(table)}`,
    "iu",
  );
}

function callsPattern(name: string): RegExp {
  const [schema = "public", bareName = ""] = name.split(".");
  return new RegExp(
    String.raw`(?<![\w$."])(?:"?${escapeRegex(schema)}"?\s*\.\s*)?"?${escapeRegex(bareName)}"?\s*\(`,
    "iu",
  );
}

/** The names `drop function` lists: `a(int), b` gives `a` and `b`. */
function droppedFunctions(list: string): readonly string[] {
  const names: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (depth === 0 && char === ",") {
      names.push(current);
      current = "";
    } else if (depth === 0) {
      current += char;
    }
  }
  names.push(current);
  return names
    .map((name) => name.replace(/\s+(?:cascade|restrict)\s*$/iu, "").trim())
    .filter((name) => name !== "")
    .map(key);
}

type Defined = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

/** The objects the migrations leave behind, each by its last definition. */
type Schema = {
  readonly relations: Map<string, "table" | "materialized view">;
  readonly views: Map<string, Defined>;
  readonly functions: Map<string, Defined>;
  readonly triggers: Map<string, RetireTrigger>;
  readonly policies: Map<
    string,
    Defined & { readonly table: string; readonly name: string }
  >;
};

function replay(statements: readonly RetireStatement[]): Schema {
  const schema: Schema = {
    relations: new Map(),
    views: new Map(),
    functions: new Map(),
    triggers: new Map(),
    policies: new Map(),
  };
  for (const statement of statements) {
    const { text } = statement;
    const defined = { file: statement.file, line: statement.line, text };
    let match = CREATE_TABLE.exec(text);
    if (match !== null) {
      schema.relations.set(key(group(match, 1)), "table");
      continue;
    }
    match = CREATE_MATVIEW.exec(text);
    if (match !== null) {
      const name = key(group(match, 1));
      schema.relations.set(name, "materialized view");
      schema.views.set(name, defined);
      continue;
    }
    match = DROP_RELATION.exec(text);
    if (match !== null) {
      for (const name of group(match, 2).split(",").map(key)) {
        schema.relations.delete(name);
        schema.views.delete(name);
      }
      continue;
    }
    match = CREATE_VIEW.exec(text);
    if (match !== null) {
      schema.views.set(key(group(match, 1)), defined);
      continue;
    }
    match = CREATE_FUNCTION.exec(text);
    if (match !== null) {
      schema.functions.set(key(group(match, 1)), defined);
      continue;
    }
    match = DROP_FUNCTION.exec(text);
    if (match !== null) {
      for (const name of droppedFunctions(group(match, 1))) {
        schema.functions.delete(name);
      }
      continue;
    }
    match = CREATE_TRIGGER.exec(text);
    if (match !== null) {
      const name = bare(group(match, 1));
      const table = key(group(match, 2));
      schema.triggers.set(`${table}:${name}`, {
        name,
        table,
        function: key(group(match, 3)),
      });
      continue;
    }
    match = DROP_TRIGGER.exec(text);
    if (match !== null) {
      schema.triggers.delete(
        `${key(group(match, 2))}:${bare(group(match, 1))}`,
      );
      continue;
    }
    match = POLICY.exec(text);
    if (match !== null) {
      const name = bare(group(match, 2));
      const table = key(group(match, 3));
      const id = `${table}:${name}`;
      const expressions = text.slice(match[0].length);
      if (
        group(match, 1).toLowerCase() === "create" ||
        /\b(?:using|with\s+check)\b/iu.test(expressions)
      ) {
        schema.policies.set(id, { ...defined, text: expressions, table, name });
      }
      continue;
    }
    match = DROP_POLICY.exec(text);
    if (match !== null) {
      schema.policies.delete(
        `${key(group(match, 2))}:${bare(group(match, 1))}`,
      );
    }
  }
  return schema;
}

/** Functions that write `table`, the configured `refresh` ones, and every function that calls one. */
function refreshFunctions(
  schema: Schema,
  table: string,
  configured: readonly string[],
): ReadonlySet<string> {
  const writes = writesPattern(table);
  const found = new Set(configured.map(key));
  for (const [name, defined] of schema.functions) {
    if (writes.test(defined.text)) {
      found.add(name);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    const calls = [...found].map(callsPattern);
    for (const [name, defined] of schema.functions) {
      if (!found.has(name) && calls.some((call) => call.test(defined.text))) {
        found.add(name);
        grew = true;
      }
    }
  }
  return found;
}

/** Calls of a legacy helper outside its own definition, grants and drops (PD056). */
export function legacyHelperCalls(
  statements: readonly RetireStatement[],
  name: string,
): { readonly count: number; readonly files: readonly string[] } {
  const own = new RegExp(
    String.raw`^\s*(?:create\s+(?:or\s+replace\s+)?function|drop\s+function|revoke|grant|alter\s+function|comment\s+on\s+function)\b[^(]*?(?:^|[\s."])${name}"?\s*\(`,
    "iu",
  );
  const call = new RegExp(
    String.raw`(?<![\w$])(?:(?:"[^"]+"|\w+)\s*\.\s*)?"?${name}"?\s*\(`,
    "giu",
  );
  let count = 0;
  const files = new Set<string>();
  for (const statement of statements) {
    const hits = own.test(statement.text)
      ? 0
      : (statement.text.match(call) ?? []).length;
    if (hits > 0) {
      count += hits;
      files.add(statement.file);
    }
  }
  return { count, files: [...files].toSorted() };
}

/** The `rls.migrate.helpers` names doctor and `rls migrate` count. */
export function legacyHelperNames(config: RlsMigrateConfig): readonly string[] {
  return Object.keys(config.helpers).filter((name) =>
    /^[a-z_][a-z0-9_]*$/u.test(name),
  );
}

/**
 * For each `rls.migrate.tables` table: whether the migrations still create it,
 * the triggers and functions that refresh it, and what still reads it.
 */
export function retirePlan(
  statements: readonly RetireStatement[],
  config: RlsMigrateConfig,
): RetirePlan {
  const schema = replay(statements);
  const uncalled = new Set(
    legacyHelperNames(config).filter(
      (name) => legacyHelperCalls(statements, name).count === 0,
    ),
  );
  const helpers = [...schema.functions.keys()]
    .filter((fn) => uncalled.has(fn.slice(fn.lastIndexOf(".") + 1)))
    .toSorted();
  const tables = Object.entries(config.tables ?? {}).map(
    ([name, table]): RetireTable => {
      const target = key(name);
      const refresh = refreshFunctions(schema, target, table.refresh ?? []);
      const reads = new RegExp(refPattern(target), "iu");
      const readers: RetireReader[] = [];
      for (const policy of schema.policies.values()) {
        if (policy.table !== target && reads.test(policy.text)) {
          readers.push({
            kind: "policy",
            name: `${policy.name} on ${policy.table}`,
            file: policy.file,
            line: policy.line,
          });
        }
      }
      for (const [view, defined] of schema.views) {
        if (view !== target && reads.test(defined.text)) {
          readers.push({
            kind: "view",
            name: view,
            file: defined.file,
            line: defined.line,
          });
        }
      }
      for (const [fn, defined] of schema.functions) {
        if (
          !refresh.has(fn) &&
          !helpers.includes(fn) &&
          reads.test(defined.text)
        ) {
          readers.push({
            kind: "function",
            name: fn,
            file: defined.file,
            line: defined.line,
          });
        }
      }
      return {
        table: target,
        present: schema.relations.has(target),
        kind: schema.relations.get(target) ?? "table",
        refreshTriggers: [...schema.triggers.values()].filter(
          (trigger) =>
            trigger.table !== target && refresh.has(trigger.function),
        ),
        refreshFunctions: [...refresh]
          .filter((fn) => schema.functions.has(fn))
          .toSorted(),
        readers,
      };
    },
  );
  return { tables, helpers };
}

function qualified(name: string): string {
  return name
    .split(".")
    .map((part) => escapeSqlIdent(part))
    .join(".");
}

/** The retire migration: each present table without readers, its refresh triggers and functions, and the uncalled helpers. */
export function retireSql(plan: RetirePlan): string | undefined {
  const tables = plan.tables.filter(
    (table) => table.present && table.readers.length === 0,
  );
  if (tables.length === 0) {
    return undefined;
  }
  const lines = [
    `${RETIRE_MARKER} table=${tables.map((table) => table.table).join(",")}`,
    "-- rls.migrate.tables: the refresh triggers and functions, uncalled legacy helpers, then the table; no cascade, so a dependant left behind fails the migration",
  ];
  for (const table of tables) {
    for (const trigger of table.refreshTriggers) {
      lines.push(
        `drop trigger if exists ${escapeSqlIdent(trigger.name)} on ${qualified(trigger.table)};`,
      );
    }
  }
  const functions = new Set(tables.flatMap((table) => table.refreshFunctions));
  for (const fn of [...functions].toSorted()) {
    lines.push(`drop function if exists ${qualified(fn)};`);
  }
  for (const helper of plan.helpers) {
    lines.push(`drop function if exists ${qualified(helper)};`);
  }
  for (const table of tables) {
    lines.push(`drop ${table.kind} if exists ${qualified(table.table)};`);
  }
  return `${lines.join("\n")}\n`;
}
