import { basename } from "node:path";

import type { ConfigRoots } from "../source/config-root.ts";
import type { Edit, Estree } from "./ast.ts";
import type { CodemodChange, CodemodFollowUp } from "./context.ts";

import { parseSync } from "../core/optional.ts";
import { resolveConfigRoot } from "../source/config-root.ts";
import {
  applyEdits,
  child,
  lineIndex,
  nameOf,
  nodes,
  position,
} from "./ast.ts";

/**
 * A config key that moved: `from` and `to` are key paths in the object passed
 * to `defineConfig` or exported as default from `permdock.config.*`. `*`
 * matches every key at that level and stands for the same key in `to`.
 */
export type ConfigMove = {
  readonly from: readonly string[];
  readonly to: readonly string[];
};

export type ConfigMoveResult = {
  readonly source: string;
  readonly changes: readonly CodemodChange[];
  readonly followUps: readonly CodemodFollowUp[];
};

/** Passes over one file before the codemod stops; each pass moves one key. */
const MAX_PASSES = 500;

function rootsOf(program: Estree, file: string): ConfigRoots {
  return resolveConfigRoot(program, {
    isConfigFile: basename(file).startsWith("permdock.config."),
  });
}

function keyOf(property: Estree): string | undefined {
  return property.type === "Property" && property.computed !== true
    ? nameOf(property.key)
    : undefined;
}

function propertyOf(object: Estree, key: string): Estree | undefined {
  return nodes(object.properties).find((property) => keyOf(property) === key);
}

function objectValue(property: Estree): Estree | undefined {
  const value = child(property, "value");
  return value?.type === "ObjectExpression" ? value : undefined;
}

type Found = {
  readonly parent: Estree;
  readonly property: Estree;
  readonly path: readonly string[];
};

/** The first property at `move.from` under `object`, with the concrete paths. */
function find(
  object: Estree,
  move: ConfigMove,
  depth: number,
  path: readonly string[],
  skipped: ReadonlySet<number>,
): Found | undefined {
  const segment = move.from[depth];
  if (segment === undefined) {
    return undefined;
  }
  const keys =
    segment === "*"
      ? nodes(object.properties).flatMap((property) => {
          const key = keyOf(property);
          return key === undefined ? [] : [key];
        })
      : [segment];
  for (const key of keys) {
    const property = propertyOf(object, key);
    if (property === undefined) {
      continue;
    }
    const at = [...path, key];
    if (depth === move.from.length - 1) {
      if (skipped.has(property.start)) {
        continue;
      }
      return { parent: object, property, path: at };
    }
    const next = objectValue(property);
    const found =
      next === undefined ? undefined : find(next, move, depth + 1, at, skipped);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** `move.to` with each `*` replaced by the key `from` matched there. */
function concreteTarget(move: ConfigMove, path: readonly string[]): string[] {
  return move.to.map((segment, index) =>
    segment === "*" ? (path[index] ?? segment) : segment,
  );
}

function removal(source: string, parent: Estree, property: Estree): Edit {
  const siblings = nodes(parent.properties);
  const index = siblings.indexOf(property);
  const next = siblings[index + 1];
  if (next !== undefined) {
    return { start: property.start, end: next.start, text: "" };
  }
  const previous = siblings[index - 1];
  const end = /^\s*,/u.exec(source.slice(property.end))?.[0].length ?? 0;
  return previous === undefined
    ? { start: property.start, end: property.end + end, text: "" }
    : { start: previous.end, end: property.end, text: "" };
}

/** Adds `text` as the last property of `object`, so moved keys keep their order. */
function append(source: string, object: Estree, text: string): Edit {
  const last = nodes(object.properties).at(-1);
  if (last === undefined) {
    return {
      start: object.start + 1,
      end: object.start + 1,
      text: ` ${text} `,
    };
  }
  const comma = /^\s*,/u.exec(source.slice(last.end))?.[0].length;
  return comma === undefined
    ? { start: last.end, end: last.end, text: `, ${text}` }
    : { start: last.end + comma, end: last.end + comma, text: ` ${text},` };
}

function nested(keys: readonly string[], value: string): string {
  const [first, ...rest] = keys;
  return rest.length === 0
    ? `${first}: ${value}`
    : `${first}: { ${nested(rest, value)} }`;
}

type Step =
  | {
      readonly kind: "edits";
      readonly edits: readonly Edit[];
      readonly at: number;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: "conflict";
      readonly at: number;
      readonly message: string;
    };

function step(source: string, found: Found, to: readonly string[]): Step {
  const relative = to.slice(found.path.length - 1);
  const value = child(found.property, "value");
  const text = value === undefined ? "" : source.slice(value.start, value.end);
  const from = found.path.join(".");
  const target = to.join(".");
  let object = found.parent;
  for (const [index, key] of relative.entries()) {
    const existing = propertyOf(object, key);
    const last = index === relative.length - 1;
    if (existing === undefined) {
      const insert = nested(relative.slice(index), text);
      return {
        kind: "edits",
        at: found.property.start,
        from,
        to: target,
        edits:
          object === found.parent
            ? [
                {
                  start: found.property.start,
                  end: found.property.end,
                  text: insert,
                },
              ]
            : [
                removal(source, found.parent, found.property),
                append(source, object, insert),
              ],
      };
    }
    const next = objectValue(existing);
    if (last || next === undefined) {
      return {
        kind: "conflict",
        at: found.property.start,
        message: `${from} moved to ${target}, which ${last ? "is already set" : "is not an object literal"}; merge it by hand`,
      };
    }
    object = next;
  }
  return {
    kind: "conflict",
    at: found.property.start,
    message: `${from} moved to ${target}; move it by hand`,
  };
}

/**
 * The first move that applies under any config root. A move that conflicts is
 * skipped from then on and reported once in `followUps`.
 */
function nextEdits(
  program: Estree,
  file: string,
  source: string,
  moves: readonly ConfigMove[],
  skipped: Set<number>,
  followUps: CodemodFollowUp[],
): Extract<Step, { kind: "edits" }> | undefined {
  for (const root of rootsOf(program, file).roots) {
    for (const move of moves) {
      const found = find(root, move, 0, [], skipped);
      if (found === undefined) {
        continue;
      }
      const result = step(source, found, concreteTarget(move, found.path));
      if (result.kind === "edits") {
        return result;
      }
      skipped.add(found.property.start);
      if (!followUps.some((item) => item.message === result.message)) {
        followUps.push({
          ...position(lineIndex(source), result.at),
          name: found.path.join("."),
          message: result.message,
        });
      }
    }
  }
  return undefined;
}

/**
 * Moves each key `moves` names to its new path, one key per pass, until no move
 * applies. A key whose target is already set, or sits under a value that is not
 * an object literal, is reported instead.
 */
export function moveConfigKeys(
  file: string,
  original: string,
  moves: readonly ConfigMove[],
): ConfigMoveResult {
  let source = original;
  const lineAt = lineIndex(original);
  const changes: CodemodChange[] = [];
  const followUps: CodemodFollowUp[] = [];
  const skipped = new Set<number>();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const parsed = parseSync(file, source, { sourceType: "module" });
    if (parsed.errors.length > 0) {
      break;
    }
    // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
    const program = parsed.program as unknown as Estree;
    if (pass === 0) {
      for (const item of rootsOf(program, file).unresolved) {
        const { line, column } = position(lineAt, item.at);
        followUps.push({
          line,
          column,
          name: basename(file),
          message: item.why,
        });
      }
    }
    const applied = nextEdits(program, file, source, moves, skipped, followUps);
    if (applied === undefined) {
      break;
    }
    changes.push({
      ...position(lineAt, Math.min(applied.at, original.length)),
      from: applied.from,
      to: applied.to,
    });
    source = applyEdits(source, applied.edits);
  }
  return { source, changes, followUps };
}
