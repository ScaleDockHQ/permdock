import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HOOK_EXPORTS } from "../../../src/cli/gen/hooks.ts";

const RECORDED: unknown = JSON.parse(
  readFileSync(
    new URL("../../../../../tests/bundle/src/exports.json", import.meta.url),
    "utf8",
  ),
);

function recorded(entry: string): readonly string[] {
  if (typeof RECORDED !== "object" || RECORDED === null) {
    return [];
  }
  const names: unknown = Reflect.get(RECORDED, entry);
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
}

describe("generated hook modules", () => {
  it("re-export every value the entry exports, by name", () => {
    for (const kind of ["react", "vue", "svelte", "solid"] as const) {
      expect([...HOOK_EXPORTS[kind]].toSorted()).toStrictEqual(
        [...recorded(`./${kind}`)].toSorted(),
      );
    }
  });
});
