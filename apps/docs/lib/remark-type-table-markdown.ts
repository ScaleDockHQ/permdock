import type { Root } from "mdast";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";

import { visit } from "unist-util-visit";
import * as v from "valibot";

const TypeDoc = v.object({
  entries: v.array(
    v.object({
      name: v.string(),
      description: v.string(),
      type: v.string(),
      required: v.boolean(),
    }),
  ),
});

function cell(text: string): string {
  return text.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");
}

function toMarkdown(node: MdxJsxFlowElement): string | undefined {
  for (const attribute of node.attributes) {
    if (
      attribute.type !== "mdxJsxAttribute" ||
      attribute.name !== "type" ||
      typeof attribute.value !== "object" ||
      attribute.value === null
    ) {
      continue;
    }
    const parsed = v.safeParse(TypeDoc, JSON.parse(attribute.value.value));
    if (!parsed.success) {
      return undefined;
    }
    const rows = parsed.output.entries.map(
      (entry) =>
        `| \`${entry.name}${entry.required ? "" : "?"}\` | \`${cell(entry.type)}\` | ${cell(entry.description)} |`,
    );
    return [
      "| Name | Type | Description |",
      "| --- | --- | --- |",
      ...rows,
    ].join("\n");
  }
  return undefined;
}

/** Gives each generated `TypeTable` a Markdown table as its `.md` and `llms.txt` form. */
export function remarkTypeTableMarkdown() {
  return (tree: Root) => {
    visit(tree, "mdxJsxFlowElement", (node: MdxJsxFlowElement) => {
      if (node.name !== "TypeTable") {
        return;
      }
      const text = toMarkdown(node);
      if (text !== undefined) {
        node.data = { ...node.data, _stringify: { text } };
      }
    });
  };
}
