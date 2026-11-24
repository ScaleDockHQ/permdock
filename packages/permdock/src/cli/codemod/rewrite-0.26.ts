import { basename, extname } from "node:path";

import type { SqlCommand } from "../../core/sql.ts";
import type { Edit, Estree } from "./ast.ts";
import type { CodemodChange, CodemodFollowUp } from "./context.ts";

import { defaultSqlCommand } from "../../core/sql.ts";
import { parseSync } from "../core/optional.ts";
import { resolveConfigRoot } from "../source/config-root.ts";
import {
  applyEditsStrict,
  propertyKey,
  removeProperty,
} from "../source/edits.ts";
import { scriptBlocks } from "../source/script-blocks.ts";
import { child, nodes, walk } from "./ast.ts";

export type RewriteResult = {
  readonly source: string;
  readonly changes: readonly CodemodChange[];
  readonly followUps: readonly CodemodFollowUp[];
};

const ROW_CALL = /\bpermitted_([a-z][a-z0-9_]*)_row\s*\(/gu;
const TEXT_BEFORE_HELPER =
  /::text(?=\s+in\s*\(\s*select\b[^)]{0,120}\b(?:permitted_|can_|member_|permdock_))/gu;
const TEXT_AFTER_HELPER =
  /(\b(?:permitted_|can_|member_|permdock_)[a-z0-9_]*\s*\([^;]{0,200}?\))::text/gu;
const OWN_SUBJECT = /\bown_subject\s*\(\s*\)/gu;
const VERB_PREFIX =
  /^(read|list|get|create|duplicate|update|delete|remove|approve|reject|cancel|send|withdraw|confirm|fulfill|receive|reimburse|writeOff|mark|pause|resume)(?=[A-Z0-9_-])/u;
const SQL_COMMANDS: ReadonlySet<string> = new Set([
  "select",
  "insert",
  "update",
  "delete",
]);
const CONFIG_FILE = /(?:^|\.)permdock\.config\.[cm]?[jt]sx?$/u;

function change(from: string, to: string): CodemodChange {
  return { line: 1, column: 0, from, to };
}

function followUp(name: string, message: string): CodemodFollowUp {
  return { line: 1, column: 0, name, message };
}

/** The 0.26 SQL rewrites of one SQL text, with a change per rewrite kind. */
function rewriteSql(source: string): { text: string; kinds: string[] } {
  const kinds: string[] = [];
  let text = source.replaceAll(ROW_CALL, "can_$1(");
  if (text !== source) {
    kinds.push("row");
  }
  const typed = text
    .replaceAll(TEXT_BEFORE_HELPER, "")
    .replaceAll(TEXT_AFTER_HELPER, "$1");
  if (typed !== text) {
    kinds.push("text");
    text = typed;
  }
  const owned = text.replaceAll(OWN_SUBJECT, "");
  if (owned !== text) {
    kinds.push("own");
    text = owned;
  }
  return { text, kinds };
}

const SQL_CHANGES: Readonly<Record<string, CodemodChange>> = {
  row: change("permitted_<resource>_row(", "can_<resource>("),
  text: change("::text", ""),
  own: change("own_subject()", ""),
};

function sqlChanges(kinds: ReadonlySet<string>): CodemodChange[] {
  return ["row", "text", "own"]
    .filter((kind) => kinds.has(kind))
    .map((kind) => SQL_CHANGES[kind] ?? change(kind, ""));
}

function inferredOf(action: string): SqlCommand | undefined {
  const exact = defaultSqlCommand(action);
  if (exact !== undefined) {
    return exact;
  }
  const verb = VERB_PREFIX.exec(action)?.[1];
  if (verb === undefined) {
    return undefined;
  }
  if (verb === "mark" || verb === "pause" || verb === "resume") {
    return "update";
  }
  return defaultSqlCommand(verb);
}

/** One module of a file: the whole file, or one Vue or Svelte script block. */
type Segment = {
  readonly code: string;
  readonly offset: number;
  readonly lang: "ts" | "tsx" | "jsx";
};

function segmentsOf(file: string, source: string): readonly Segment[] {
  const extension = extname(file).slice(1).toLowerCase();
  if (extension === "vue" || extension === "svelte") {
    return scriptBlocks(source);
  }
  const lang =
    extension === "tsx"
      ? "tsx"
      : ["ts", "mts", "cts"].includes(extension)
        ? "ts"
        : "jsx";
  return [{ code: source, offset: 0, lang }];
}

function stringValue(node: Estree | undefined): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}

/** The raw text between the delimiters of a string literal or template part. */
function rawRange(node: Estree): { start: number; end: number } | undefined {
  if (node.type === "Literal" && typeof node.value === "string") {
    return { start: node.start + 1, end: node.end - 1 };
  }
  if (node.type === "TemplateElement") {
    const raw: unknown =
      typeof node.value === "object" && node.value !== null
        ? Reflect.get(node.value, "raw")
        : undefined;
    return typeof raw === "string"
      ? { start: node.start + 1, end: node.start + 1 + raw.length }
      : undefined;
  }
  return undefined;
}

/** Old `permdock gen` file names (without extension) to the 0.26 names. */
const GEN_FILES: Readonly<Record<string, string>> = {
  generated: "constants",
  zod: "zod",
  valibot: "valibot",
  arktype: "arktype",
  factories: "factories",
  react: "react",
  vue: "vue",
  solid: "solid",
  "svelte-stores": "svelte",
  messages: "messages",
};

const GEN_IMPORT =
  /^((?:[^'"\n]*\/)?)permdock\.(generated|zod|valibot|arktype|factories|react|vue|solid|svelte-stores|schemas|messages)(\.[a-z]+)?$/u;

const MODULE_SOURCES: ReadonlySet<string> = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
]);

/**
 * An import of a generated file under its 0.25 name moves to the new name:
 * `permdock.generated.ts` is `constants.ts`, `permdock.schemas.ts` is
 * `standard-schema.ts` and `permdock.schemas.json` is `json-schema.json`.
 */
function genImport(
  specifier: string,
): { text: string; change: CodemodChange } | undefined {
  const match = GEN_IMPORT.exec(specifier);
  if (match === null) {
    return undefined;
  }
  const [, dir = "", name = "", ext = ""] = match;
  const next =
    name === "schemas"
      ? ext === ".json"
        ? "json-schema"
        : "standard-schema"
      : (GEN_FILES[name] ?? name);
  return {
    text: `${dir}${next}${ext}`,
    change: change(`permdock.${name}${ext}`, `${next}${ext}`),
  };
}

type Collected = {
  readonly edits: Edit[];
  readonly changes: CodemodChange[];
  readonly followUps: CodemodFollowUp[];
  readonly sqlKinds: Set<string>;
};

/** SQL rewrites inside string and template literals, and generated imports. */
function literalEdits(
  program: Estree,
  segment: Segment,
  into: Collected,
): void {
  const sources = new Set<Estree>();
  walk(program, (node) => {
    if (MODULE_SOURCES.has(node.type)) {
      const source = node.source;
      if (source !== null && source !== undefined) {
        sources.add(source);
      }
      return;
    }
    const range = rawRange(node);
    if (range === undefined) {
      return;
    }
    const text = segment.code.slice(range.start, range.end);
    const at = {
      start: segment.offset + range.start,
      end: segment.offset + range.end,
    };
    if (sources.has(node)) {
      const moved = genImport(text);
      if (moved !== undefined) {
        into.edits.push({ ...at, text: moved.text });
        into.changes.push(moved.change);
      }
      return;
    }
    const sql = rewriteSql(text);
    if (sql.kinds.length > 0) {
      into.edits.push({ ...at, text: sql.text });
      for (const kind of sql.kinds) {
        into.sqlKinds.add(kind);
      }
    }
  });
}

/** The object literals that are a config root or sit inside one. */
function objectsUnder(program: Estree, roots: ReadonlySet<Estree>): Estree[] {
  const found: Estree[] = [];
  walk(program, (node, _parent, ancestors) => {
    if (
      node.type === "ObjectExpression" &&
      (roots.has(node) || ancestors.some((item) => roots.has(item)))
    ) {
      found.push(node);
    }
  });
  return found;
}

/** The owner a `{ tableOf: "owner" }` value names, or `undefined`. */
function tableOfOwner(value: Estree | undefined): string | undefined {
  const properties = nodes(value?.properties);
  const only = properties[0];
  if (
    value?.type !== "ObjectExpression" ||
    properties.length !== 1 ||
    only === undefined ||
    propertyKey(only) !== "tableOf"
  ) {
    return undefined;
  }
  return stringValue(child(only, "value"));
}

function quoteOf(raw: string | undefined): string {
  return raw?.startsWith("'") === true ? "'" : '"';
}

/** The edit that lists `children` on the owner's `also`, or `undefined`. */
function alsoEdit(
  code: string,
  value: Estree | undefined,
  children: readonly string[],
): { start: number; end: number; text: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = (node: Estree | undefined): string | undefined =>
    node === undefined ? undefined : code.slice(node.start, node.end);
  const listed = (quote: string): string =>
    children.map((name) => `${quote}${name}${quote}`).join(", ");
  if (stringValue(value) !== undefined) {
    const table = raw(value) ?? '""';
    return {
      start: value.start,
      end: value.end,
      text: `{ table: ${table}, also: [${listed(quoteOf(table))}] }`,
    };
  }
  if (value.type !== "ObjectExpression") {
    return undefined;
  }
  const properties = nodes(value.properties);
  const table = properties.find((item) => propertyKey(item) === "table");
  const tableQuote = quoteOf(raw(child(table ?? value, "value")));
  const also = child(
    properties.find((item) => propertyKey(item) === "also") ?? value,
    "value",
  );
  if (also?.type === "ArrayExpression") {
    const elements = nodes(also.elements);
    const last = elements.at(-1);
    if (last === undefined) {
      return {
        start: also.start,
        end: also.end,
        text: `[${listed(tableQuote)}]`,
      };
    }
    const quote = quoteOf(raw(elements[0]));
    return { start: last.end, end: last.end, text: `, ${listed(quote)}` };
  }
  if (properties.length === 0) {
    return {
      start: value.start,
      end: value.end,
      text: `{ also: [${listed(tableQuote)}] }`,
    };
  }
  return {
    start: value.start + 1,
    end: value.start + 1,
    text: ` also: [${listed(tableQuote)}],`,
  };
}

/** `{ tableOf }` entries of one object move onto their owner's `also` list. */
function tableOfEdits(
  file: string,
  code: string,
  object: Estree,
  into: Collected,
): boolean {
  const byOwner = new Map<string, string[]>();
  const properties = nodes(object.properties);
  for (const property of properties) {
    const name = propertyKey(property);
    const owner = tableOfOwner(child(property, "value"));
    if (name === undefined || owner === undefined) {
      continue;
    }
    into.edits.push(removeProperty(code, object, property));
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), name]);
  }
  for (const [owner, children] of byOwner) {
    const property = properties.find((item) => propertyKey(item) === owner);
    const edit = alsoEdit(
      code,
      property === undefined ? undefined : child(property, "value"),
      children,
    );
    if (edit === undefined) {
      for (const name of children) {
        into.followUps.push(
          followUp(
            "tableOf",
            `${file}: rls.tables.${name}.tableOf names ${owner}, which this file does not declare as a property the codemod can extend`,
          ),
        );
      }
      continue;
    }
    into.edits.push(edit);
  }
  return byOwner.size > 0;
}

/** Inferred `rls.actions` entries of one `rls` object are dropped. */
function actionEdits(code: string, rls: Estree, into: Collected): void {
  const actions = child(
    nodes(rls.properties).find((item) => propertyKey(item) === "actions") ??
      rls,
    "value",
  );
  if (actions?.type !== "ObjectExpression") {
    return;
  }
  for (const property of nodes(actions.properties)) {
    const name = propertyKey(property);
    const value = stringValue(child(property, "value"));
    if (
      name === undefined ||
      value === undefined ||
      !SQL_COMMANDS.has(value) ||
      inferredOf(name) !== value
    ) {
      continue;
    }
    into.edits.push(removeProperty(code, actions, property));
    into.changes.push(change(`rls.actions ${name}: "${value}"`, "inferred"));
  }
}

function configEdits(
  file: string,
  program: Estree,
  segment: Segment,
  into: Collected,
): void {
  const shifted = (from: number): void => {
    for (let index = from; index < into.edits.length; index += 1) {
      const edit = into.edits[index];
      if (edit !== undefined) {
        into.edits[index] = {
          start: edit.start + segment.offset,
          end: edit.end + segment.offset,
          text: edit.text,
        };
      }
    }
  };
  const roots = new Set(
    resolveConfigRoot(program, {
      isConfigFile: CONFIG_FILE.test(basename(file)),
    }).roots,
  );
  const first = into.edits.length;
  let moved = false;
  for (const object of objectsUnder(program, roots)) {
    moved = tableOfEdits(file, segment.code, object, into) || moved;
    const rls = child(
      nodes(object.properties).find((item) => propertyKey(item) === "rls") ??
        object,
      "value",
    );
    if (rls?.type === "ObjectExpression" && rls !== object) {
      actionEdits(segment.code, rls, into);
    }
  }
  shifted(first);
  if (moved) {
    into.changes.push(change("tableOf", "also"));
  }
}

/**
 * In a `better-supabase.config.*` file, `roleThrough`, `permissions.disabled`
 * and a `canAssign` that names `permdock_can_assign_any` become follow-ups,
 * because the provider supplies them only in some setups and PD094 decides
 * whether a value equals the provider's.
 */
function suppliedFollowUps(file: string, program: Estree): CodemodFollowUp[] {
  let roleThrough = false;
  let disabled = false;
  let canAssign = false;
  walk(program, (node, parent, ancestors) => {
    const key = propertyKey(node);
    if (key === "roleThrough") {
      roleThrough = true;
    } else if (key === "disabled") {
      const holder = ancestors.at(-2);
      disabled ||=
        parent?.type === "ObjectExpression" &&
        holder !== undefined &&
        propertyKey(holder) === "permissions";
    } else if (key === "canAssign") {
      canAssign ||=
        stringValue(child(node, "value"))?.includes(
          "permdock_can_assign_any",
        ) === true;
    }
  });
  const found: CodemodFollowUp[] = [];
  if (roleThrough) {
    found.push(
      followUp(
        "roleThrough",
        `${file}: roleThrough is kept: the provider supplies it only for a membership source whose role reads through that table; delete it when permdock doctor reports it as PD094`,
      ),
    );
  }
  if (disabled) {
    found.push(
      followUp(
        "permissions.disabled",
        `${file}: blocks.permissions.disabled is kept: the provider fills it from rls.suspension only under blocks.permissions.model "provider", and only for an unset subject; delete it when permdock doctor reports it as PD094`,
      ),
    );
  }
  if (canAssign) {
    found.push(
      followUp(
        "canAssign",
        `${file}: canAssign naming permdock_can_assign_any is kept: the provider fills platformRoles.canAssign only for its own tenant scope, and another scope or a through.where narrows it; delete it when permdock doctor reports it as PD094`,
      ),
    );
  }
  return found;
}

/**
 * 0.26 rewrites. In a `.sql` file and inside string and template literals,
 * `permitted_<resource>_row(` becomes `can_<resource>(`, `::text` around a
 * helper call is removed and `own_subject()` is deleted. In a config object, `{
 * tableOf }` moves onto the owner's `also` list and inferred `rls.actions`
 * entries are dropped. Imports of the old generated files move to the new
 * names.
 */
export function rewrite026(file: string, source: string): RewriteResult {
  if (extname(file) === ".sql") {
    const sql = rewriteSql(source);
    return {
      source: sql.text,
      changes: sqlChanges(new Set(sql.kinds)),
      followUps: [],
    };
  }
  const into: Collected = {
    edits: [],
    changes: [],
    followUps: [],
    sqlKinds: new Set(),
  };
  const programs: Estree[] = [];
  for (const segment of segmentsOf(file, source)) {
    const parsed = parseSync(`segment.${segment.lang}`, segment.code, {
      lang: segment.lang,
      sourceType: "module",
    });
    if (parsed.errors.length > 0) {
      return { source, changes: [], followUps: [] };
    }
    // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
    const program = parsed.program as unknown as Estree;
    programs.push(program);
    literalEdits(program, segment, into);
    configEdits(file, program, segment, into);
  }
  let text: string;
  try {
    text = applyEditsStrict(source, into.edits);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    return {
      source,
      changes: [],
      followUps: [followUp("0.26", `${file}: left as it is: ${error.message}`)],
    };
  }
  const changes = [...sqlChanges(into.sqlKinds), ...into.changes];
  const followUps = [...into.followUps];
  if (changes.some((item) => item.from.startsWith("permdock."))) {
    followUps.push(
      followUp(
        "gen",
        `${file}: the generated files moved; rename topics.<x> to <x>Topic, paths.<x> to <x>Path, sqlNames.* to the per-helper exports in sql.ts, factories.<x> to <x>Factory, and scopes and roles to scopeNames and roleNames`,
      ),
    );
  }
  if (file.includes("better-supabase.config.")) {
    followUps.push(
      ...programs.flatMap((program) => suppliedFollowUps(file, program)),
    );
  }
  return { source: text, changes, followUps };
}
