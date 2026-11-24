import { describe, expect, it } from "vitest";

import type { Estree } from "../../../src/cli/codemod/ast.ts";

import { moveConfigKeys } from "../../../src/cli/codemod/config-moves.ts";
import { parseSync } from "../../../src/cli/core/optional.ts";
import { resolveConfigRoot } from "../../../src/cli/source/config-root.ts";
import {
  applyEditsStrict,
  propertyKey,
  removeProperty,
} from "../../../src/cli/source/edits.ts";
import { scriptBlocks } from "../../../src/cli/source/script-blocks.ts";

function roots(text: string, file = "permdock.config.ts") {
  // SAFETY: Estree is an all-optional view of the Oxc program
  const program = parseSync(file, text).program as unknown as Estree;
  return resolveConfigRoot(program, {
    isConfigFile: file.startsWith("permdock.config"),
  });
}

describe(scriptBlocks, () => {
  it("does not end the tag at the `>` of a generic attribute", () => {
    const text =
      '<script setup lang="ts" generic="T extends Record<string, any>">\nconst a: T = 1;\n</script>\n<template />';
    const [block] = scriptBlocks(text);
    expect(block?.code).toBe("\nconst a: T = 1;\n");
    expect(block?.lang).toBe("ts");
    expect(text.slice(block?.offset, (block?.offset ?? 0) + 4)).toBe("\ncon");
  });

  it("reads lang tsx and several blocks", () => {
    const blocks = scriptBlocks(
      "<script lang='tsx'>a</script><script context=\"module\">b</script>",
    );
    expect(blocks.map((block) => [block.lang, block.code])).toStrictEqual([
      ["tsx", "a"],
      ["jsx", "b"],
    ]);
  });
});

describe(resolveConfigRoot, () => {
  it("follows a const, satisfies and an as cast", () => {
    const found = roots(
      'import { defineConfig } from "permdock/cli";\nconst config = defineConfig({ a: 1 } as never);\nexport default config satisfies object;\n',
    );
    expect(found.roots).toHaveLength(1);
    expect(found.unresolved).toStrictEqual([]);
  });

  it("follows a namespace call and an aliased import", () => {
    expect(
      roots(
        'import * as p from "permdock/cli";\nexport default p.defineConfig({ a: 1 });',
      ).roots,
    ).toHaveLength(1);
    expect(
      roots(
        'import { defineConfig as dc } from "permdock/cli";\nexport default dc({ a: 1 });',
      ).roots,
    ).toHaveLength(1);
  });

  it("follows a default-exported function's return and module.exports", () => {
    expect(roots("export default () => ({ a: 1 });").roots).toHaveLength(1);
    expect(roots("module.exports = { a: 1 };").roots).toHaveLength(1);
  });

  it("never takes another tool's defineConfig", () => {
    const found = roots(
      'import { defineConfig } from "vite";\nexport default defineConfig({ plugins: [] });',
      "vite.config.ts",
    );
    expect(found.roots).toStrictEqual([]);
  });

  it("reports an imported const and a spread instead of skipping them", () => {
    const imported = roots(
      'import base from "./base.ts";\nexport default base;',
    );
    expect(imported.roots).toStrictEqual([]);
    expect(imported.unresolved[0]?.why).toContain("base");
    const spread = roots("export default { ...base, a: 1 };");
    expect(spread.roots).toHaveLength(1);
    expect(spread.unresolved[0]?.why).toContain("spread");
  });
});

describe(removeProperty, () => {
  function remove(text: string, key: string): string {
    const found = roots(text, "permdock.config.ts").roots[0];
    const property = found?.properties?.find(
      (item) => propertyKey(item) === key,
    );
    if (found === undefined || property === undefined) {
      throw new Error(`no ${key} in the fixture`);
    }
    return applyEditsStrict(text, [removeProperty(text, found, property)]);
  }

  it("removes the comment lines above a property and its comma", () => {
    expect(
      remove(
        "export default {\n  a: 1,\n  // drop me\n  b: 2,\n  c: 3,\n};\n",
        "b",
      ),
    ).toBe("export default {\n  a: 1,\n  c: 3,\n};\n");
  });

  it("removes a method property whole", () => {
    expect(
      remove(
        "export default {\n  fieldMeta() {\n    return 1;\n  },\n  a: 1,\n};\n",
        "fieldMeta",
      ),
    ).toBe("export default {\n  a: 1,\n};\n");
  });

  it("takes the preceding comma for the last inline property", () => {
    expect(remove("export default { a: 1, b: 2 };\n", "b")).toBe(
      "export default { a: 1 };\n",
    );
  });
});

describe(applyEditsStrict, () => {
  it("rejects overlapping edits", () => {
    expect(() =>
      applyEditsStrict("abcdef", [
        { start: 1, end: 4, text: "" },
        { start: 3, end: 5, text: "x" },
      ]),
    ).toThrow(RangeError);
  });
});

describe(moveConfigKeys, () => {
  it("reports an unresolved spread once", () => {
    const result = moveConfigKeys(
      "permdock.config.ts",
      'import { defineConfig } from "permdock/cli";\nexport default defineConfig({ ...base, old: 1 });\n',
      [{ from: ["old"], to: ["next"] }],
    );
    expect(
      result.followUps.filter((item) => item.message.includes("spread")),
    ).toHaveLength(1);
    expect(result.source).toContain("next: 1");
  });
});
