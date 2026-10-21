import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CommandResult } from "../core/result.ts";
import type {
  ImportedGrant,
  ImportedRole,
  ImportedValue,
  ImportedWhere,
} from "./policy-module.ts";

import { isRecord } from "../../core/compact.ts";
import { applyFiles } from "../core/files.ts";
import { emitPolicyModule, isIdentifier } from "./policy-module.ts";

/**
 * One CASL rule as `ability.rules` holds it, or the packed array `packRules`
 * writes.
 */
type RawRule = {
  readonly action: string | readonly string[];
  readonly subject?: string | readonly string[];
  readonly fields?: string | readonly string[];
  readonly conditions?: Readonly<Record<string, unknown>>;
  readonly inverted?: boolean;
};

/** Why a CASL rule, or part of it, did not import as written. */
export type CaslSkipReason =
  | "not-a-rule"
  | "no-subject"
  | "not-an-identifier"
  | "unsupported-condition"
  | "deny-widened";

export type CaslSkip = {
  readonly role: string;
  readonly rule: number;
  readonly reason: CaslSkipReason;
  readonly detail: string;
};

const CRUD = ["create", "read", "update", "delete"] as const;

const OPERATORS: Readonly<
  Record<string, "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "notIn">
> = {
  $eq: "eq",
  $ne: "ne",
  $gt: "gt",
  $gte: "gte",
  $lt: "lt",
  $lte: "lte",
  $in: "in",
  $nin: "notIn",
};

const PRINCIPAL_TEMPLATE = /^\$\{user\.([A-Za-z_$][A-Za-z0-9_$]*)\}$/u;

function list(
  value: string | readonly string[] | undefined,
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return typeof value === "string" ? [value] : value;
}

function isStrings(value: unknown): value is string | readonly string[] {
  return (
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/** `packRules` joins a list into one comma-separated string. */
function split(item: unknown): unknown {
  return typeof item === "string" && item.includes(",")
    ? item.split(",")
    : item;
}

/**
 * A rule in either shape: the object form, or `packRules`' `[action, subject,
 * conditions, inverted, fields]`.
 */
function readRule(value: unknown): RawRule | undefined {
  if (Array.isArray(value)) {
    const [action, subject, conditions, inverted, fields]: readonly unknown[] =
      value;
    return readRule({
      action: split(action),
      subject: split(subject),
      ...(isRecord(conditions) ? { conditions } : {}),
      ...(inverted === 1 || inverted === true ? { inverted: true } : {}),
      ...(fields === undefined || fields === 0
        ? {}
        : { fields: split(fields) }),
    });
  }
  if (!isRecord(value) || !isStrings(value["action"])) {
    return undefined;
  }
  const { subject, fields, conditions, inverted } = value;
  if (
    (subject !== undefined && !isStrings(subject)) ||
    (fields !== undefined && !isStrings(fields)) ||
    (conditions !== undefined && !isRecord(conditions)) ||
    (inverted !== undefined && typeof inverted !== "boolean")
  ) {
    return undefined;
  }
  return {
    action: value["action"],
    ...(subject === undefined ? {} : { subject }),
    ...(fields === undefined ? {} : { fields }),
    ...(conditions === undefined ? {} : { conditions }),
    ...(inverted === true ? { inverted: true } : {}),
  };
}

/** A CASL subject type as a resource key: `BlogPost` becomes `blogPost`. */
function resourceKey(subject: string): string {
  return `${subject.slice(0, 1).toLowerCase()}${subject.slice(1)}`;
}

type Unsupported = { readonly unsupported: string };

function isUnsupported(read: object): read is Unsupported {
  return "unsupported" in read;
}

function readValue(
  value: unknown,
): { readonly value: ImportedValue } | Unsupported {
  if (typeof value === "string") {
    const principal = PRINCIPAL_TEMPLATE.exec(value)?.[1];
    return { value: principal === undefined ? value : { principal } };
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return { value };
  }
  if (Array.isArray(value)) {
    const items: ImportedValue[] = [];
    for (const item of value) {
      const read = readValue(item);
      if (isUnsupported(read)) {
        return read;
      }
      items.push(read.value);
    }
    return { value: items };
  }
  return { unsupported: "a nested object value" };
}

type Read = ImportedWhere | Unsupported;

/**
 * The Mongo-query subset CASL conditions use, as a `where`; anything else is
 * reported by name.
 */
function readConditions(conditions: Readonly<Record<string, unknown>>): Read {
  const parts: ImportedWhere[] = [];
  for (const [key, value] of Object.entries(conditions)) {
    if (key === "$and" || key === "$or" || key === "$nor") {
      if (!Array.isArray(value)) {
        return { unsupported: `${key} without a list` };
      }
      const items: ImportedWhere[] = [];
      for (const item of value) {
        const read = isRecord(item)
          ? readConditions(item)
          : { unsupported: `${key} item` };
        if (isUnsupported(read)) {
          return read;
        }
        items.push(read);
      }
      parts.push(
        key === "$and"
          ? { and: items }
          : key === "$or"
            ? { or: items }
            : { not: { or: items } },
      );
      continue;
    }
    if (key.startsWith("$")) {
      return { unsupported: key };
    }
    if (key.includes(".")) {
      return { unsupported: `the nested field ${key}` };
    }
    const read = readField(key, value);
    if (isUnsupported(read)) {
      return read;
    }
    parts.push(read);
  }
  return parts.length === 1 && parts[0] !== undefined
    ? parts[0]
    : { and: parts };
}

function readField(field: string, value: unknown): Read {
  if (!isRecord(value)) {
    const read = readValue(value);
    return isUnsupported(read) ? read : { field, op: "eq", value: read.value };
  }
  const parts: ImportedWhere[] = [];
  for (const [operator, operand] of Object.entries(value)) {
    if (operator === "$exists") {
      parts.push({ field, op: "isNull", value: operand !== true });
      continue;
    }
    const op = OPERATORS[operator];
    if (op === undefined) {
      return { unsupported: operator };
    }
    const read = readValue(operand);
    if (isUnsupported(read)) {
      return read;
    }
    parts.push({ field, op, value: read.value });
  }
  return parts.length === 1 && parts[0] !== undefined
    ? parts[0]
    : { and: parts };
}

/** The subjects and the actions each is named with, `all` and `manage` aside. */
function collectActions(
  rule: RawRule,
  subjects: Set<string>,
  actionsBySubject: Map<string, Set<string>>,
): void {
  for (const subject of list(rule.subject).filter((item) => item !== "all")) {
    subjects.add(subject);
    const actions = actionsBySubject.get(subject) ?? new Set<string>();
    actionsBySubject.set(subject, actions);
    for (const action of list(rule.action)) {
      if (action !== "manage") {
        actions.add(action);
      }
    }
  }
}

export type CaslImport = {
  readonly actions: ReadonlyMap<string, ReadonlySet<string>>;
  readonly roles: readonly ImportedRole[];
  readonly skipped: readonly CaslSkip[];
};

/**
 * CASL rules per role, as PermDock roles: `inverted` rules are denies, `manage`
 * and `all` expand to every action and subject the rules name, and conditions
 * in the portable Mongo-query subset become `where`. A deny whose condition
 * does not import keeps its effect without the condition, so the import can
 * only deny more, never less.
 */
export function importCasl(
  rulesByRole: Readonly<Record<string, readonly unknown[]>>,
): CaslImport {
  const parsed: { role: string; index: number; rule: RawRule }[] = [];
  const skipped: CaslSkip[] = [];
  const subjects = new Set<string>();
  const actionsBySubject = new Map<string, Set<string>>();
  for (const [role, rules] of Object.entries(rulesByRole)) {
    for (const [index, raw] of rules.entries()) {
      const rule = readRule(raw);
      if (rule === undefined) {
        skipped.push({
          role,
          rule: index,
          reason: "not-a-rule",
          detail: "not a CASL raw rule",
        });
        continue;
      }
      parsed.push({ role, index, rule });
      collectActions(rule, subjects, actionsBySubject);
    }
  }
  const actionsOf = (subject: string): readonly string[] => {
    // `manage` covers the actions the rules name that can be keys; a bad name is reported where it is named.
    const named = [...(actionsBySubject.get(subject) ?? [])].filter(
      isIdentifier,
    );
    return named.length === 0 ? CRUD : named;
  };
  const resources = new Map<string, Set<string>>();
  const roles = new Map<string, ImportedGrant[]>();
  for (const { role, index, rule } of parsed) {
    const grants = roles.get(role) ?? [];
    roles.set(role, grants);
    const named = list(rule.subject);
    if (named.length === 0) {
      skipped.push({
        role,
        rule: index,
        reason: "no-subject",
        detail: "a claim-only rule (no subject) has no resource to grant on",
      });
      continue;
    }
    const effect = rule.inverted === true ? "deny" : "allow";
    let where: ImportedWhere | undefined;
    if (rule.conditions !== undefined) {
      const read = readConditions(rule.conditions);
      if (isUnsupported(read)) {
        if (effect === "allow") {
          skipped.push({
            role,
            rule: index,
            reason: "unsupported-condition",
            detail: `${read.unsupported} has no portable condition; the allow is left out`,
          });
          continue;
        }
        skipped.push({
          role,
          rule: index,
          reason: "deny-widened",
          detail: `${read.unsupported} has no portable condition; the deny applies without it`,
        });
      } else {
        where = read;
      }
    }
    const fields = list(rule.fields);
    const expanded = named.includes("all")
      ? [...new Set([...named.filter((item) => item !== "all"), ...subjects])]
      : named;
    for (const subject of expanded) {
      const key = resourceKey(subject);
      for (const action of list(rule.action).flatMap((item) =>
        item === "manage" ? actionsOf(subject) : [item],
      )) {
        if (!isIdentifier(key) || !isIdentifier(action)) {
          skipped.push({
            role,
            rule: index,
            reason: "not-an-identifier",
            detail: `${subject}.${action} is not a permission key`,
          });
          continue;
        }
        const actions = resources.get(key) ?? new Set<string>();
        resources.set(key, actions);
        actions.add(action);
        grants.push({
          effect,
          resource: key,
          action,
          ...(where === undefined ? {} : { where }),
          ...(fields.length === 0 ? {} : { fields }),
        });
      }
    }
  }
  return {
    actions: resources,
    roles: [...roles.entries()].map(([name, grants]) => ({ name, grants })),
    skipped,
  };
}

/**
 * `permdock casl import`: CASL rules per role into a `permissions` and `policy`
 * module.
 */
export function runCaslImport(input: {
  readonly cwd: string;
  readonly rules: string | undefined;
  readonly out: string | undefined;
  readonly json: boolean;
}): CommandResult {
  if (input.rules === undefined || input.out === undefined) {
    return {
      code: 2,
      output: "casl import needs --rules <file> and --out <file>",
    };
  }
  const path = resolve(input.cwd, input.rules);
  if (!existsSync(path)) {
    return {
      code: 2,
      output: `casl import --rules: ${input.rules} does not exist`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {
      code: 2,
      output: `casl import --rules: ${input.rules} is not JSON`,
    };
  }
  if (
    !isRecord(parsed) ||
    !Object.values(parsed).every((rules) => Array.isArray(rules))
  ) {
    return {
      code: 2,
      output:
        "casl import --rules: expected { [role]: rules }, each role's ability.rules or packRules output",
    };
  }
  // SAFETY: every value was checked to be an array just above.
  const imported = importCasl(parsed as Record<string, readonly unknown[]>);
  applyFiles(input.cwd, [
    {
      path: input.out,
      text: emitPolicyModule({
        generator: "casl import",
        actions: imported.actions,
        roles: imported.roles,
      }),
    },
  ]);
  if (input.json) {
    return {
      code: 0,
      output: JSON.stringify({ out: input.out, skipped: imported.skipped }),
    };
  }
  const grants = imported.roles.reduce(
    (total, role) => total + role.grants.length,
    0,
  );
  return {
    code: 0,
    output: [
      ...imported.skipped.map(
        (item) =>
          `${item.reason}: role ${item.role}, rule ${String(item.rule)}: ${item.detail}`,
      ),
      `casl import: wrote ${String(imported.roles.length)} role(s) with ${String(grants)} grant(s) to ${input.out}, skipped ${String(imported.skipped.filter((item) => item.reason !== "deny-widened").length)}`,
    ].join("\n"),
  };
}
