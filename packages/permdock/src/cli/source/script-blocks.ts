/** One `<script>` block of a Vue or Svelte file. */
export interface ScriptBlock {
  readonly code: string;
  /** Index of the first character of `code` in the file. */
  readonly offset: number;
  readonly lang: "ts" | "tsx" | "jsx";
}

/** The index of the `>` that ends the tag whose attributes start at `from`. */
function tagEnd(text: string, from: number): number {
  let quote: string | undefined;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return at;
    }
  }
  return -1;
}

function langOf(attributes: string): ScriptBlock["lang"] {
  const value = /\blang\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/u.exec(
    attributes,
  );
  const lang = (value?.[1] ?? value?.[2] ?? value?.[3] ?? "").toLowerCase();
  if (lang === "tsx") {
    return "tsx";
  }
  return lang === "ts" || lang === "typescript" ? "ts" : "jsx";
}

/**
 * The `<script>` blocks of a Vue or Svelte file. The tag scanner respects
 * quoted attributes, so `generic="T extends Record<string, any>"` does not end
 * the tag at its `>`.
 */
export function scriptBlocks(text: string): readonly ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const open = /<script(?=[\s>])/giu;
  let match = open.exec(text);
  while (match !== null) {
    const attributesFrom = match.index + match[0].length;
    const end = tagEnd(text, attributesFrom);
    if (end === -1) {
      break;
    }
    const close = text.toLowerCase().indexOf("</script", end);
    const stop = close === -1 ? text.length : close;
    blocks.push({
      code: text.slice(end + 1, stop),
      offset: end + 1,
      lang: langOf(text.slice(attributesFrom, end)),
    });
    open.lastIndex = stop;
    match = open.exec(text);
  }
  return blocks;
}
