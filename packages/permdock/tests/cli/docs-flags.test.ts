import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { Flag, Flags } from "../../src/cli/core/command.ts";

import { GLOBAL_FLAGS } from "../../src/cli/core/context.ts";
import { leaves } from "../../src/cli/core/manifest.ts";

const CLI_DOCS = path.join(
  import.meta.dirname,
  "../../../../apps/docs/content/docs/cli",
);

function page(name: string): string {
  return readFileSync(path.join(CLI_DOCS, `${name}.mdx`), "utf8");
}

/** How the docs write a flag: `--no-x` for a boolean that is on by default. */
function spelling(name: string, flag: Flag): string {
  return flag.type === "boolean" && flag.default === true
    ? `--no-${name}`
    : `--${name}`;
}

function documented(flags: Flags): readonly string[] {
  return Object.entries(flags)
    .filter(([, flag]) => flag.hidden !== true)
    .map(([name, flag]) => spelling(name, flag));
}

/** Every spelling the parser accepts for `flags`, `--no-x` included. */
function spellings(flags: Flags): readonly string[] {
  return Object.keys(flags).flatMap((name) => [`--${name}`, `--no-${name}`]);
}

/** `--out` but not `--out-dir`: a flag named on the page as a whole word. */
function mentions(docs: string, flag: string): boolean {
  return new RegExp(`${flag}(?![\\w-])`, "u").test(docs);
}

/** The flags a page's tables list in their first column. */
function tableFlags(docs: string): readonly string[] {
  return docs
    .split("\n")
    .map((line) => /^\|\s*`(--[a-z][a-z0-9-]*)/u.exec(line)?.[1])
    .filter((flag) => flag !== undefined);
}

const LEAVES = leaves().filter(({ entry }) => entry.hidden !== true);

const PAGES = [...new Set(LEAVES.map(({ entry }) => entry.docs))];

describe("CLI flag docs", () => {
  it("documents every global flag on docs/cli/index.mdx", () => {
    const docs = page("index");
    expect(
      documented(GLOBAL_FLAGS).filter((flag) => !mentions(docs, flag)),
    ).toEqual([]);
  });

  it.each(
    LEAVES.map(({ path: words, entry }) => [words.join(" "), entry] as const),
  )("documents every flag of permdock %s on its page", async (_name, entry) => {
    const leaf = await entry.load();
    const docs = page(entry.docs);
    expect(
      documented(leaf.flags).filter((flag) => !mentions(docs, flag)),
    ).toEqual([]);
  });

  it.each(PAGES)(
    "lists the side effects the manifest declares on docs/cli/%s.mdx",
    (name) => {
      const docs = page(name);
      const start = docs.indexOf("\n## Side effects\n");
      expect(start).toBeGreaterThan(-1);
      const end = docs.indexOf("\n## ", start + 1);
      const rows = docs
        .slice(start, end === -1 ? undefined : end)
        .split("\n")
        .map((line) =>
          /^\|\s*`permdock ([^`]+)`\s*\|\s*(.+?)\s*\|$/u.exec(line),
        )
        .filter((match) => match !== null)
        .map((match) => [match[1], match[2]?.replaceAll("`", "")]);
      expect(rows).toEqual(
        LEAVES.filter(({ entry }) => entry.docs === name).map(
          ({ path: words, entry }) => [
            words.join(" "),
            entry.effects.length === 0 ? "None" : entry.effects.join(", "),
          ],
        ),
      );
    },
  );

  it.each(PAGES)(
    "lists no flag in a table on docs/cli/%s.mdx that its commands do not take",
    async (name) => {
      const known = new Set(spellings(GLOBAL_FLAGS));
      for (const { entry } of LEAVES.filter(
        (item) => item.entry.docs === name,
      )) {
        for (const flag of spellings((await entry.load()).flags)) {
          known.add(flag);
        }
      }
      expect(tableFlags(page(name)).filter((flag) => !known.has(flag))).toEqual(
        [],
      );
    },
  );
});
