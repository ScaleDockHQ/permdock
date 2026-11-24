import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { PlannedFile } from "../core/files.ts";
import type { CommandResult } from "../core/result.ts";
import type { SqlNode } from "../sql/ast.ts";
import type { RlsApprovalManagerRows } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { CliError } from "../core/errors.ts";
import { applyFiles, refuseDirty } from "../core/files.ts";
import { rel } from "../files.ts";
import { readConfig } from "../project/config.ts";
import {
  ACCESSIBLE_ROW_IDS,
  MANAGED_ROW_IDS,
  MANAGED_ROW_IDS_IN,
  MANAGES_ROW,
  REQUEST_APPROVER_IDS,
} from "../rls/approval-chain.ts";
import { checkedManagers, isManagerRows } from "../rls/approval-managers.ts";
import { charIndex, parseSqlFile, removeStatements } from "../sql/ast.ts";
import { supabaseDir } from "../supabase-dir.ts";

/** What `permdock codemod manager-chain --json` prints. */
export type ManagerChainReport = {
  /** Each hand-written function and the generated helper that replaces it. */
  readonly replaced: readonly { readonly from: string; readonly to: string }[];
  /** Hand-written walks left in place, with the reason. */
  readonly kept: readonly { readonly name: string; readonly reason: string }[];
  readonly files: readonly string[];
};

type Definition = {
  readonly name: string;
  readonly file: string;
  readonly node: SqlNode;
  readonly body: string;
  readonly args: readonly string[];
  readonly returns: string;
  readonly setof: boolean;
};

function strings(list: unknown): readonly string[] {
  return Array.isArray(list)
    ? list.flatMap((item: unknown) =>
        isRecord(item) &&
        isRecord(item["String"]) &&
        typeof item["String"]["sval"] === "string"
          ? [item["String"]["sval"]]
          : [],
      )
    : [];
}

function sqlFiles(dir: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .toSorted()
    .flatMap((entry) =>
      statSync(join(dir, entry)).isDirectory()
        ? sqlFiles(join(dir, entry))
        : entry.endsWith(".sql")
          ? [join(dir, entry)]
          : [],
    );
}

function definitionOf(file: string, node: SqlNode): Definition | undefined {
  if (node.kind !== "CreateFunctionStmt") {
    return undefined;
  }
  const name = strings(node.node["funcname"]).join(".");
  const options = Array.isArray(node.node["options"])
    ? node.node["options"]
    : [];
  let body = "";
  for (const option of options) {
    const def: unknown = isRecord(option) ? option["DefElem"] : undefined;
    if (isRecord(def) && def["defname"] === "as") {
      const arg = def["arg"];
      body = strings(
        isRecord(arg) && isRecord(arg["List"]) ? arg["List"]["items"] : [],
      ).join("");
    }
  }
  const parameters = Array.isArray(node.node["parameters"])
    ? node.node["parameters"]
    : [];
  const args = parameters.flatMap((parameter: unknown) => {
    const fp: unknown = isRecord(parameter)
      ? parameter["FunctionParameter"]
      : undefined;
    if (!isRecord(fp) || fp["mode"] === "FUNC_PARAM_TABLE") {
      return [];
    }
    const type = isRecord(fp["argType"]) ? strings(fp["argType"]["names"]) : [];
    return [
      `${typeof fp["name"] === "string" ? fp["name"] : ""}:${type.at(-1) ?? ""}`,
    ];
  });
  const returnType = node.node["returnType"];
  const returns = isRecord(returnType)
    ? (strings(returnType["names"]).at(-1) ?? "")
    : "";
  return {
    name,
    file,
    node,
    body,
    args,
    returns,
    setof: isRecord(returnType) && returnType["setof"] === true,
  };
}

/**
 * The generated helper a hand-written walk of the manager table matches, by its
 * signature, or the reason it matches none.
 */
function helperFor(
  definition: Definition,
  managers: RlsApprovalManagerRows,
): { readonly helper: string } | { readonly reason: string } {
  const lower = definition.body.toLowerCase();
  const table = managers.table.split(".").at(-1)?.toLowerCase() ?? "";
  if (
    !/\bwith\s+recursive\b/u.test(lower) ||
    !lower.includes(table) ||
    !lower.includes(managers.reportsTo.toLowerCase())
  ) {
    return { reason: "does not walk the manager table" };
  }
  const statuses = [
    ...lower.matchAll(/\bstatus\b\s*(<>|!=|=|not\s+in|in)\s*\(?\s*'([^']*)'/gu),
  ].map((match) => ({
    negated: /<>|!=|not/u.test(match[1] ?? ""),
    value: match[2] ?? "",
  }));
  const active = managers.active;
  for (const status of statuses) {
    const listed = status.negated ? active?.inactive : active?.active;
    if (listed?.includes(status.value) !== true) {
      return {
        reason: `filters status ${status.negated ? "<>" : "="} '${status.value}', which rls.approvals.managers.active does not state`,
      };
    }
  }
  if (
    (active?.active?.length ?? 0) + (active?.inactive?.length ?? 0) > 0 &&
    statuses.length === 0
  ) {
    return {
      reason:
        "has no status filter, and rls.approvals.managers.active sets one",
    };
  }
  const args = definition.args;
  if (!definition.setof && definition.returns === "bool" && args.length === 1) {
    return { helper: MANAGES_ROW };
  }
  if (!definition.setof) {
    return { reason: "returns neither a boolean nor a set" };
  }
  if (args.length === 0) {
    return { helper: MANAGED_ROW_IDS };
  }
  if (args.length === 1 && /permission/u.test(args[0] ?? "")) {
    return { helper: ACCESSIBLE_ROW_IDS };
  }
  if (args.length === 1) {
    return { helper: MANAGED_ROW_IDS_IN };
  }
  if (args.length === 2 && definition.returns === "uuid") {
    return { helper: REQUEST_APPROVER_IDS };
  }
  return { reason: "its signature matches no generated helper" };
}

type Call = { readonly name: string; readonly location: number };

function calls(node: unknown, out: Call[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      calls(item, out);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const call = node["FuncCall"];
  if (isRecord(call) && typeof call["location"] === "number") {
    out.push({
      name: strings(call["funcname"]).join("."),
      location: call["location"],
    });
  }
  for (const value of Object.values(node)) {
    calls(value, out);
  }
}

/** The text of a call's function name at `at`, quoted or not. */
function nameLength(text: string, at: number): number {
  const match = /^(?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?/u.exec(
    text.slice(at),
  );
  return match?.[0].length ?? 0;
}

async function rewriteCalls(
  text: string,
  renames: ReadonlyMap<string, string>,
  offset: number,
  edits: { start: number; end: number; text: string }[],
): Promise<void> {
  const nodes = await parseSqlFile(text);
  const at = charIndex(text);
  for (const node of nodes) {
    const found: Call[] = [];
    calls(node.node, found);
    for (const call of found) {
      const to = renames.get(call.name);
      if (to !== undefined) {
        const start = at(call.location);
        edits.push({
          start: offset + start,
          end: offset + start + nameLength(text, start),
          text: to,
        });
      }
    }
    const definition = definitionOf("", node);
    const language = /\blanguage\s+(\w+)/iu.exec(node.text)?.[1]?.toLowerCase();
    if (definition !== undefined && definition.body !== "") {
      const bodyAt = text.indexOf(definition.body, node.start);
      if (bodyAt !== -1 && language === "sql") {
        await rewriteCalls(definition.body, renames, offset + bodyAt, edits);
      } else if (bodyAt !== -1) {
        edits.push(...plpgsqlCalls(definition.body, renames, offset + bodyAt));
      }
    }
  }
}

/**
 * Call sites in a body that is not SQL, found as the qualified name followed by
 * `(`; the SQL parser cannot read PL/pgSQL.
 */
function plpgsqlCalls(
  body: string,
  renames: ReadonlyMap<string, string>,
  offset: number,
): readonly { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const [from, to] of renames) {
    const pattern = new RegExp(
      `${from
        .split(".")
        .map((part) => `"?${part}"?`)
        .join("\\s*\\.\\s*")}(?=\\s*\\()`,
      "gu",
    );
    for (const match of body.matchAll(pattern)) {
      out.push({
        start: offset + match.index,
        end: offset + match.index + match[0].length,
        text: to,
      });
    }
  }
  return out;
}

function applyEdits(
  text: string,
  edits: readonly { start: number; end: number; text: string }[],
): string {
  let out = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** Statements that name a function only to grant, revoke or comment on it. */
function namesFunction(node: SqlNode, names: ReadonlySet<string>): boolean {
  if (
    node.kind !== "GrantStmt" &&
    node.kind !== "CommentStmt" &&
    node.kind !== "AlterFunctionStmt"
  ) {
    return false;
  }
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!isRecord(value)) return;
    const owa = value["ObjectWithArgs"];
    if (isRecord(owa)) found.push(strings(owa["objname"]).join("."));
    for (const inner of Object.values(value)) walk(inner);
  };
  walk(node.node);
  return found.length > 0 && found.every((name) => names.has(name));
}

/**
 * `permdock codemod manager-chain`: finds the hand-written functions in
 * `supabase/schemas` that walk `rls.approvals.managers`, matches each to a
 * generated helper by signature, rewrites every call site to the helper and
 * deletes the definition with its grants. A walk whose status filter differs
 * from `active` stays, and the report names the difference.
 */
export async function runManagerChain(options: {
  readonly cwd: string;
  readonly schemas?: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly json: boolean;
}): Promise<CommandResult> {
  const { config } = await readConfig(options.cwd);
  const given = config.rls?.approvals;
  const raw = typeof given === "object" ? given.managers : undefined;
  if (raw === undefined) {
    throw new CliError(
      "usage",
      "codemod manager-chain needs rls.approvals.managers in permdock.config",
      { code: "invalid_value" },
    );
  }
  const managers = checkedManagers(raw, { scopes: [] });
  if (!isManagerRows(managers)) {
    throw new CliError(
      "usage",
      "codemod manager-chain needs the self-referencing form of rls.approvals.managers: { table, id, reportsTo, user }",
      { code: "invalid_value" },
    );
  }
  const schema = config.rls?.schema ?? "permdock";
  const dir = join(
    options.cwd,
    options.schemas ?? `${supabaseDir(options.cwd)}/schemas`,
  );
  const files = sqlFiles(dir);
  const texts = new Map(
    files.map((file) => [file, readFileSync(file, "utf8")]),
  );
  const parsed = new Map<string, readonly SqlNode[]>();
  const definitions: Definition[] = [];
  for (const [file, text] of texts) {
    const nodes = await parseSqlFile(text);
    parsed.set(file, nodes);
    for (const node of nodes) {
      const definition = definitionOf(file, node);
      if (
        definition !== undefined &&
        !definition.name.startsWith(`${schema}.`)
      ) {
        definitions.push(definition);
      }
    }
  }
  const replaced: { from: string; to: string }[] = [];
  const kept: { name: string; reason: string }[] = [];
  const renames = new Map<string, string>();
  for (const definition of definitions) {
    const match = helperFor(definition, managers);
    if ("helper" in match) {
      renames.set(definition.name, `${schema}.${match.helper}`);
      replaced.push({ from: definition.name, to: `${schema}.${match.helper}` });
    } else if (match.reason !== "does not walk the manager table") {
      kept.push({ name: definition.name, reason: match.reason });
    }
  }
  const planned: PlannedFile[] = [];
  const names = new Set(renames.keys());
  for (const [file, text] of texts) {
    const edits: { start: number; end: number; text: string }[] = [];
    await rewriteCalls(text, renames, 0, edits);
    const rewritten = applyEdits(text, edits);
    const without = removeStatements(
      rewritten,
      await parseSqlFile(rewritten),
      (node) =>
        names.has(definitionOf(file, node)?.name ?? "") ||
        namesFunction(node, names),
    );
    if (without !== text) {
      planned.push({ path: file, text: without });
    }
  }
  if (!options.dryRun) {
    refuseDirty({
      command: "codemod",
      invocation: "codemod manager-chain",
      cwd: options.cwd,
      paths: planned.map((file) => file.path),
      force: options.force,
    });
    applyFiles(options.cwd, planned);
  }
  const report: ManagerChainReport = {
    replaced,
    kept,
    files: planned.map((file) => rel(options.cwd, file.path)),
  };
  if (options.json) {
    return { code: 0, output: JSON.stringify(report, null, 2), data: report };
  }
  return {
    code: 0,
    output: [
      ...replaced.map((entry) => `${entry.from} -> ${entry.to}`),
      ...kept.map((entry) => `kept ${entry.name}: ${entry.reason}`),
      ...(replaced.length === 0 && kept.length === 0
        ? ["No hand-written manager walks found."]
        : []),
    ].join("\n"),
  };
}
