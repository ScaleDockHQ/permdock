import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  HOOK_EXPORTS,
  hooksModule,
  policySpecifier,
} from "../../../src/cli/gen/hooks.ts";

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

  it("binds each adapter's instance getter and roles reader, with use client first", () => {
    for (const kind of ["react", "vue", "svelte", "solid"] as const) {
      const text = hooksModule(kind, "../policy.js", "// header");
      expect(text.split("\n\n")[1]).toBe('"use client";');
      expect(text).toContain("export type Vocabulary");
      expect(text).toContain(
        'import type { ScopeName } from "./constants.ts";',
      );
      expect(text).not.toContain("export *");
    }
    expect(hooksModule("vue", "../policy.js", "//")).toContain(
      "MaybeRefOrGetter<RolesOptions>",
    );
    expect(hooksModule("solid", "../policy.js", "//")).toContain(
      "Accessor<RolesOptions>",
    );
    expect(hooksModule("svelte", "../policy.js", "//")).toContain(
      "() => RolesOptions",
    );
  });

  it("names the policy by its js output, relative to the file", () => {
    expect(
      policySpecifier("/p/src/permdock/react.ts", "/p/src/policy.ts"),
    ).toBe("../policy.js");
    expect(policySpecifier("/p/src/react.ts", "/p/src/policy.mts")).toBe(
      "./policy.mjs",
    );
    expect(policySpecifier("/p/a/react.ts", "/p/a/policy.tsx")).toBe(
      "./policy.js",
    );
    expect(policySpecifier("/p/a/react.ts", "/p/a/policy")).toBe("./policy");
  });
});
