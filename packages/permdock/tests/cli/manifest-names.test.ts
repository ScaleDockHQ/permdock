import { describe, expect, it } from "vitest";

import { flagSpellings } from "../../src/cli/core/args.ts";
import { GLOBAL_FLAGS } from "../../src/cli/core/context.ts";
import {
  type Entry,
  RESERVED_NAMES,
  ROOT,
  leaves,
} from "../../src/cli/core/manifest.ts";

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

function entries(children: readonly Entry[]): readonly Entry[] {
  return children.flatMap((child) =>
    child.kind === "group" ? [child, ...entries(child.children)] : [child],
  );
}

describe("the command manifest", () => {
  const all = entries(ROOT.children);

  it("keeps the reserved names free", () => {
    expect(
      all.filter((entry) => RESERVED_NAMES.includes(entry.name)),
    ).toStrictEqual([]);
  });

  it("names every visible command in kebab-case", () => {
    const visible = all.filter(
      (entry) => entry.kind === "group" || entry.hidden !== true,
    );
    expect(visible.filter((entry) => !KEBAB.test(entry.name))).toStrictEqual(
      [],
    );
  });

  it("gives siblings distinct names", () => {
    function duplicates(children: readonly Entry[]): readonly string[] {
      const names = children.map((child) => child.name);
      return [
        ...names.filter((name, index) => names.indexOf(name) !== index),
        ...children.flatMap((child) =>
          child.kind === "group" ? duplicates(child.children) : [],
        ),
      ];
    }
    expect(duplicates(ROOT.children)).toStrictEqual([]);
  });

  it.each(leaves().map(({ path, entry }) => [path.join(" "), entry] as const))(
    "%s declares no global flag and only kebab-case flags",
    async (_path, entry) => {
      const leaf = await entry.load();
      const globals = flagSpellings(GLOBAL_FLAGS);
      expect(
        flagSpellings(leaf.flags).filter((spelling) =>
          globals.includes(spelling),
        ),
      ).toStrictEqual([]);
      expect(
        Object.keys(leaf.flags).filter((name) => !KEBAB.test(name)),
      ).toStrictEqual([]);
    },
  );
});
