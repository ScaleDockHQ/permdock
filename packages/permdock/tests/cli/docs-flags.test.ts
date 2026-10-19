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

const LEAVES = leaves().filter(({ entry }) => entry.hidden !== true);

describe("CLI flag docs", () => {
  it("documents every global flag on docs/cli/index.mdx", () => {
    const docs = page("index");
    expect(
      documented(GLOBAL_FLAGS).filter((flag) => !docs.includes(flag)),
    ).toEqual([]);
  });

  it.each(
    LEAVES.map(({ path: words, entry }) => [words.join(" "), entry] as const),
  )("documents every flag of permdock %s on its page", async (_name, entry) => {
    const leaf = await entry.load();
    const docs = page(entry.docs);
    expect(
      documented(leaf.flags).filter((flag) => !docs.includes(flag)),
    ).toEqual([]);
  });
});
