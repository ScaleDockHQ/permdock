import type { Edit, Estree } from "../codemod/ast.ts";

import { nameOf, nodes } from "../codemod/ast.ts";

/**
 * Applies `edits` to `text`. Two edits that overlap would corrupt the file, so
 * this throws instead of choosing one.
 *
 * @throws {RangeError} When two edits overlap.
 */
export function applyEditsStrict(text: string, edits: readonly Edit[]): string {
  const ordered = edits.toSorted((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let cursor = 0;
  for (const item of ordered) {
    if (item.start < cursor) {
      throw new RangeError(
        `edits overlap at ${String(item.start)} (previous edit ends at ${String(cursor)})`,
      );
    }
    out += text.slice(cursor, item.start) + item.text;
    cursor = item.end;
  }
  return out + text.slice(cursor);
}

/** The key of a property written as `key:`, `"key":` or a method `key() {}`. */
export function propertyKey(property: Estree): string | undefined {
  if (
    (property.type !== "Property" && property.type !== "MethodDefinition") ||
    property.computed === true
  ) {
    return undefined;
  }
  return nameOf(property.key);
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/u;

/**
 * The edit that removes `property` from `object`: the property, the comment
 * lines directly above it and the comma that belongs to it. Method properties
 * (`fieldMeta() {}`) are removed whole. A property that shares its line with
 * another takes the neighbouring comma instead of a line break.
 */
export function removeProperty(
  text: string,
  object: Estree,
  property: Estree,
): Edit {
  const siblings = nodes(object.properties);
  const index = siblings.indexOf(property);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  const floor = previous === undefined ? object.start + 1 : previous.end;
  const lineStart = text.lastIndexOf("\n", property.start - 1) + 1;
  const ownLine =
    lineStart > floor && text.slice(lineStart, property.start).trim() === "";
  if (!ownLine) {
    if (next !== undefined) {
      return { start: property.start, end: next.start, text: "" };
    }
    const comma = /^\s*,/u.exec(text.slice(property.end))?.[0].length ?? 0;
    return previous === undefined
      ? { start: property.start, end: property.end + comma, text: "" }
      : { start: previous.end, end: property.end, text: "" };
  }
  let start = lineStart;
  while (start > floor) {
    const before = text.lastIndexOf("\n", start - 2) + 1;
    if (before <= floor || !COMMENT_LINE.test(text.slice(before, start))) {
      break;
    }
    start = before;
  }
  const tail = /^[^\S\n]*,?[^\S\n]*(?:\/\/[^\n]*)?(?:\n|$)/u.exec(
    text.slice(property.end),
  );
  return { start, end: property.end + (tail?.[0].length ?? 0), text: "" };
}
