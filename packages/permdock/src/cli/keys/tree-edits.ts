import type { Edit, Estree } from "../codemod/ast.ts";

import { nodes } from "../codemod/ast.ts";

/** The start of the line `index` is on. */
function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

/**
 * The edit that appends `item` to an array or object literal: on its own line
 * with the last item's indent when the literal spans lines, after `, `
 * otherwise. A trailing comma stays trailing.
 */
export function appendItem(
  text: string,
  container: Estree,
  items: readonly Estree[],
  item: string,
): Edit {
  const last = items.at(-1);
  if (last === undefined) {
    const brace = text[container.start] === "{";
    return {
      start: container.start + 1,
      end: container.end - 1,
      text: brace ? ` ${item} ` : item,
    };
  }
  const comma = /^\s*,/u.exec(text.slice(last.end, container.end - 1));
  const multiline = text.slice(container.start, last.start).includes("\n");
  const indent = text.slice(lineStart(text, last.start), last.start);
  const at = last.end + (comma?.[0].length ?? 0);
  if (multiline && indent.trim() === "") {
    return {
      start: at,
      end: at,
      text: comma === null ? `,\n${indent}${item}` : `\n${indent}${item},`,
    };
  }
  return {
    start: at,
    end: at,
    text: comma === null ? `, ${item}` : ` ${item}`,
  };
}

/**
 * The edit that removes `item` from an array literal with the comma that
 * belongs to it.
 */
export function removeElement(text: string, array: Estree, item: Estree): Edit {
  const elements = nodes(array.elements);
  const index = elements.indexOf(item);
  const next = elements[index + 1];
  if (next !== undefined) {
    return { start: item.start, end: next.start, text: "" };
  }
  const previous = elements[index - 1];
  if (previous !== undefined) {
    return { start: previous.end, end: item.end, text: "" };
  }
  // A lone `"a",` would leave `[,]`, an array with one hole.
  const comma = /^\s*,/u.exec(text.slice(item.end))?.[0].length ?? 0;
  return { start: item.start, end: item.end + comma, text: "" };
}
