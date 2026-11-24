import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { BaselineEntry } from "../doctor/baseline-file.ts";
import type { Edit, Estree } from "./ast.ts";
import type { CodemodChange, CodemodFile, CodemodFollowUp } from "./context.ts";

import { isRecord } from "../../core/compact.ts";
import { baselineText, parseBaseline } from "../doctor/baseline-file.ts";
import { configProperty } from "../source/config-paths.ts";
import { applyEditsStrict, removeProperty } from "../source/edits.ts";
import { child, lineIndex, nameOf, nodes, position } from "./ast.ts";

const DEFAULT_BASELINE = "doctor-baseline.json";

/**
 * The JSON value of a literal: strings, numbers, booleans, `null`, arrays and
 * objects with plain keys. `undefined` for anything the file computes.
 */
function literalValue(node: Estree | null | undefined): unknown {
  if (node === null || node === undefined) {
    return undefined;
  }
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral": {
      const quasis = nodes(Reflect.get(node, "quasis"));
      if (nodes(Reflect.get(node, "expressions")).length > 0) {
        return undefined;
      }
      const value: unknown =
        quasis.length === 1 ? Reflect.get(quasis[0] ?? {}, "value") : undefined;
      return isRecord(value) ? value["cooked"] : undefined;
    }
    case "ArrayExpression": {
      const items = (node.elements ?? []).map((item) => literalValue(item));
      return items.includes(undefined) ? undefined : items;
    }
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const property of nodes(node.properties)) {
        const key =
          property.type === "Property" && property.computed !== true
            ? nameOf(property.key)
            : undefined;
        const value = literalValue(child(property, "value"));
        if (key === undefined || value === undefined) {
          return undefined;
        }
        out[key] = value;
      }
      return out;
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ParenthesizedExpression":
      return literalValue(child(node, "expression"));
    default:
      return undefined;
  }
}

type Read =
  | { readonly kind: "entries"; readonly entries: readonly BaselineEntry[] }
  | { readonly kind: "unread"; readonly why: string };

const text = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/**
 * `doctor.waivers` entries `{ code: "PD017", key, reason }` as baseline
 * entries.
 */
function waiverEntries(value: unknown): Read {
  if (!Array.isArray(value)) {
    return { kind: "unread", why: "doctor.waivers is not a literal list" };
  }
  const entries: BaselineEntry[] = [];
  for (const item of value) {
    if (!isRecord(item) || !text(item["code"]) || !text(item["key"])) {
      return {
        kind: "unread",
        why: "a doctor.waivers entry has no code or key",
      };
    }
    entries.push({
      code: item["code"],
      target: item["key"],
      reason: typeof item["reason"] === "string" ? item["reason"] : "",
    });
  }
  return { kind: "entries", entries };
}

/**
 * `doctor.ignore` entries `{ id: "<code>:<target>", reason }` as baseline
 * entries.
 */
function ignoreEntries(value: unknown): Read {
  if (!Array.isArray(value)) {
    return { kind: "unread", why: "doctor.ignore is not a literal list" };
  }
  const entries: BaselineEntry[] = [];
  for (const item of value) {
    const id = isRecord(item) ? item["id"] : undefined;
    const colon = typeof id === "string" ? id.indexOf(":") : -1;
    if (!isRecord(item) || typeof id !== "string" || colon <= 0) {
      return {
        kind: "unread",
        why: "a doctor.ignore entry has no <code>:<target> id",
      };
    }
    entries.push({
      code: id.slice(0, colon),
      target: id.slice(colon + 1),
      reason: typeof item["reason"] === "string" ? item["reason"] : "",
    });
  }
  return { kind: "entries", entries };
}

type Found = {
  readonly object: Estree;
  readonly property: Estree;
  readonly read: Read;
  readonly name: string;
};

/**
 * 0.31: `doctor.waivers` and `doctor.ignore` fold into the `doctor.baseline`
 * file. The config loses both keys and gains `baseline` when it has none, and
 * the entries land in the file it names, merged with what the file holds. A
 * list the config computes, or a baseline path that is not a literal, is a
 * follow-up and nothing changes.
 */
export function rewriteDoctorBaseline(
  file: string,
  source: string,
): {
  readonly source: string;
  readonly changes: readonly CodemodChange[];
  readonly followUps: readonly CodemodFollowUp[];
  readonly files?: readonly CodemodFile[];
} {
  const unchanged = { source, changes: [], followUps: [] };
  let found: Found[];
  let baseline: ReturnType<typeof configProperty>;
  try {
    const at = (key: string) => configProperty(file, source, ["doctor", key]);
    const waivers = at("waivers");
    const ignore = at("ignore");
    found = [
      ...(waivers === undefined
        ? []
        : [
            {
              ...waivers,
              read: waiverEntries(
                literalValue(child(waivers.property, "value")),
              ),
              name: "doctor.waivers",
            },
          ]),
      ...(ignore === undefined
        ? []
        : [
            {
              ...ignore,
              read: ignoreEntries(
                literalValue(child(ignore.property, "value")),
              ),
              name: "doctor.ignore",
            },
          ]),
    ];
    baseline = at("baseline");
  } catch {
    return unchanged;
  }
  const [first] = found;
  if (first === undefined) {
    return unchanged;
  }
  const lineAt = lineIndex(source);
  const followUp = (at: Estree, name: string, message: string) => ({
    source,
    changes: [],
    followUps: [{ ...position(lineAt, at.start), name, message }],
  });
  for (const item of found) {
    if (item.read.kind === "unread") {
      return followUp(
        item.property,
        item.name,
        `${item.read.why}; move its entries into the doctor.baseline file by hand`,
      );
    }
  }
  const path =
    baseline === undefined
      ? DEFAULT_BASELINE
      : literalValue(child(baseline.property, "value"));
  if (typeof path !== "string" || path === "") {
    return followUp(
      first.property,
      "doctor.baseline",
      "doctor.baseline is not a string literal; move doctor.waivers and doctor.ignore into its file by hand",
    );
  }
  const entries = found.flatMap((item) =>
    item.read.kind === "entries" ? item.read.entries : [],
  );
  const target = resolve(dirname(file), path);
  let existing: readonly BaselineEntry[] = [];
  if (existsSync(target)) {
    try {
      existing = parseBaseline(readFileSync(target, "utf8"), path);
    } catch (error) {
      return followUp(
        first.property,
        "doctor.baseline",
        `${path} does not parse (${error instanceof Error ? error.message : String(error)}); merge doctor.waivers and doctor.ignore into it by hand`,
      );
    }
  }
  const edits: Edit[] = found.map((item, index) =>
    index === 0 && baseline === undefined && entries.length > 0
      ? {
          start: item.property.start,
          end: item.property.end,
          text: `baseline: ${JSON.stringify(path)}`,
        }
      : removeProperty(source, item.object, item.property),
  );
  const changes = found.map((item) => ({
    ...position(lineAt, item.property.start),
    from: item.name,
    to: entries.length === 0 ? "" : `doctor.baseline (${path})`,
  }));
  return {
    source: applyEditsStrict(source, edits),
    changes,
    followUps: [],
    ...(entries.length === 0
      ? {}
      : {
          files: [
            { path: target, text: baselineText([...existing, ...entries]) },
          ],
        }),
  };
}
