import type { ObjectExpression, ObjectProperty, ParseResult } from "oxc-parser";

import { Visitor, parseSync } from "oxc-parser";

import type { Edit } from "./ast.ts";
import type { CodemodChange, CodemodFollowUp } from "./context.ts";

import { applyEdits, lineIndex, position } from "./ast.ts";

const COMBINATORS: ReadonlySet<string> = new Set(["any", "all", "sequential"]);

/** The keys a 0.16 membership literal may carry. */
const MEMBERSHIP_KEYS: ReadonlySet<string> = new Set([
  "tenant",
  "team",
  "roles",
  "eligible",
  "via",
  "expiresAt",
  "grantedBy",
  "reason",
  "member",
  "managedBy",
  "entitlements",
  "keep",
  "x",
]);

export type LiteralResult = {
  readonly source: string;
  readonly changes: readonly CodemodChange[];
  readonly followUps: readonly CodemodFollowUp[];
};

type Keyed = { readonly key: string; readonly property: ObjectProperty };

function keyed(object: ObjectExpression): readonly Keyed[] {
  const out: Keyed[] = [];
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed) {
      continue;
    }
    const { key } = property;
    if (key.type === "Identifier") {
      out.push({ key: key.name, property });
    } else if (key.type === "Literal" && typeof key.value === "string") {
      out.push({ key: key.value, property });
    }
  }
  return out;
}

function stringLiteral(property: ObjectProperty): string | undefined {
  const { value } = property;
  return value.type === "Literal" && typeof value.value === "string"
    ? value.value
    : undefined;
}

function langOf(file: string): "js" | "jsx" | "ts" | "tsx" {
  if (file.endsWith(".tsx")) {
    return "tsx";
  }
  if (file.endsWith(".jsx")) {
    return "jsx";
  }
  return /\.[cm]?ts$/u.test(file) ? "ts" : "js";
}

/**
 * The end of `property` plus the comma and whitespace after it, so removing the
 * span leaves the object well formed.
 */
function withTrailingComma(source: string, property: ObjectProperty): number {
  const match = /^\s*,\s*/u.exec(source.slice(property.end));
  return property.end + (match?.[0].length ?? 0);
}

/**
 * 0.17's object-literal rewrites:
 *
 * - A membership `{ tenant, team?, roles }` becomes `{ scope, id, within? }`
 *   under the `tenant` and `team` scope aliases. Only an object whose keys are
 *   all membership fields counts, so credentials, events and principals that
 *   carry `tenant` and `roles` stay as they are.
 * - An approval option's `mode: 'any' | 'all' | 'sequential'` becomes `combine`,
 *   `distinct: false` becomes `mode: 'confirm'`, and `distinct: true` (the
 *   default) goes.
 *
 * A `distinct` that is not a literal and every `ApprovalMode` type reference
 * are follow-ups.
 */
export function rewriteLiterals017(
  file: string,
  source: string,
): LiteralResult {
  let parsed: ParseResult;
  try {
    parsed = parseSync(file, source, {
      lang: langOf(file),
      sourceType: "module",
    });
  } catch {
    return { source, changes: [], followUps: [] };
  }
  if (parsed.errors.length > 0) {
    return { source, changes: [], followUps: [] };
  }
  const lineAt = lineIndex(source);
  const edits: Edit[] = [];
  const changes: CodemodChange[] = [];
  const followUps: CodemodFollowUp[] = [];
  const text = (node: { start: number; end: number }): string =>
    source.slice(node.start, node.end);
  const change = (at: number, from: string, to: string): void => {
    changes.push({ ...position(lineAt, at), from, to });
  };
  const membership = (
    node: ObjectExpression,
    props: readonly Keyed[],
  ): void => {
    const keys = new Set(props.map((item) => item.key));
    if (
      props.length !== node.properties.length ||
      !keys.has("roles") ||
      (!keys.has("tenant") && !keys.has("team")) ||
      [...keys].some((key) => !MEMBERSHIP_KEYS.has(key))
    ) {
      return;
    }
    const tenant = props.find((item) => item.key === "tenant")?.property;
    const team = props.find((item) => item.key === "team")?.property;
    if (
      [tenant, team].some(
        (item) =>
          item?.value.type === "ObjectExpression" ||
          item?.value.type === "ArrayExpression",
      )
    ) {
      return;
    }
    if (team === undefined && tenant !== undefined) {
      const to = `scope: "tenant", id: ${text(tenant.value)}`;
      edits.push({ start: tenant.start, end: tenant.end, text: to });
      change(tenant.start, text(tenant), to);
      return;
    }
    if (team !== undefined) {
      const to = `scope: "team", id: ${text(team.value)}`;
      edits.push({ start: team.start, end: team.end, text: to });
      change(team.start, text(team), to);
    }
    if (tenant !== undefined) {
      const value = text(tenant.value);
      const to = `within: { ${value === "tenant" ? value : `tenant: ${value}`} }`;
      edits.push({ start: tenant.start, end: tenant.end, text: to });
      change(tenant.start, text(tenant), to);
    }
  };
  const approval = (props: readonly Keyed[]): void => {
    const keys = new Set(props.map((item) => item.key));
    if (!keys.has("by") && !keys.has("stages")) {
      return;
    }
    const mode = props.find((item) => item.key === "mode")?.property;
    const value = mode === undefined ? undefined : stringLiteral(mode);
    if (mode !== undefined && value !== undefined && COMBINATORS.has(value)) {
      edits.push({ start: mode.key.start, end: mode.key.end, text: "combine" });
      change(mode.start, text(mode), `combine: ${text(mode.value)}`);
    }
    const distinct = props.find((item) => item.key === "distinct")?.property;
    if (distinct === undefined) {
      return;
    }
    const literal = distinct.value;
    if (literal.type === "Literal" && literal.value === false) {
      edits.push({
        start: distinct.start,
        end: distinct.end,
        text: 'mode: "confirm"',
      });
      change(distinct.start, text(distinct), 'mode: "confirm"');
    } else if (literal.type === "Literal" && literal.value === true) {
      edits.push({
        start: distinct.start,
        end: withTrailingComma(source, distinct),
        text: "",
      });
      change(
        distinct.start,
        text(distinct),
        "(removed: authorize is the default)",
      );
    } else {
      followUps.push({
        ...position(lineAt, distinct.start),
        name: "distinct",
        message:
          'distinct is gone since 0.17.0: `mode: "confirm"` where it was false; drop it where it was true',
      });
    }
  };
  new Visitor({
    ObjectExpression(node) {
      const props = keyed(node);
      membership(node, props);
      approval(props);
    },
    TSTypeReference(node) {
      if (
        node.typeName.type === "Identifier" &&
        node.typeName.name === "ApprovalMode"
      ) {
        followUps.push({
          ...position(lineAt, node.start),
          name: "ApprovalMode",
          message:
            "ApprovalMode is `'confirm' | 'authorize'` since 0.17.0; the stage combinator type is ApprovalCombine",
        });
      }
    },
  }).visit(parsed.program);
  return { source: applyEdits(source, edits), changes, followUps };
}
