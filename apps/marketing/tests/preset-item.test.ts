import { readFileSync } from "node:fs";
import {
  ARCHETYPES,
  FEATURES,
  encodePreset,
  generatePreset,
  resolvePreset,
} from "permdock/preset";
import { registryItemSchema } from "shadcn/schema";
import { describe, expect, it } from "vitest";

import { presetItem } from "../lib/preset-item";

const ORIGIN = "https://permdock.com";

describe("presetItem", () => {
  it("builds a valid shadcn registry block that writes the preset's files", () => {
    const code = encodePreset(
      resolvePreset({
        archetype: "b2b",
        framework: "hono",
        backend: "prisma",
        integrations: ["shadcn"],
      }),
    );
    const item = presetItem(code, ORIGIN);
    expect(registryItemSchema.safeParse(item).success).toBe(true);
    expect(item).toMatchObject({
      name: `preset-${code}`,
      type: "registry:block",
      dependencies: expect.arrayContaining([
        "permdock",
        "zod",
        "hono",
        "@prisma/client",
      ]),
      registryDependencies: expect.arrayContaining([
        `${ORIGIN}/r/gated-button.json`,
        `${ORIGIN}/r/tenant-switcher.json`,
      ]),
    });
    // SAFETY: presetItem builds files as an array of { path, type, target, content }.
    const files = (item?.["files"] ?? []) as readonly { target: string }[];
    expect(files.map((file) => file.target)).toStrictEqual(
      expect.arrayContaining([
        "~/src/policy.ts",
        "~/prisma/schema.prisma",
        "~/permdock.config.ts",
      ]),
    );
  });

  it("refuses a code it cannot read", () => {
    expect(presetItem("p9nope", ORIGIN)).toBeNull();
  });
});

describe("registry.json", () => {
  it("has every recipe a preset can ask for", () => {
    const registry: { readonly items: readonly { readonly name: string }[] } =
      JSON.parse(
        readFileSync(new URL("../registry.json", import.meta.url), "utf8"),
      );
    const names = new Set(registry.items.map((item) => item.name));
    for (const archetype of ARCHETYPES) {
      const generated = generatePreset(
        resolvePreset({
          archetype: archetype.id,
          features: FEATURES.map((feature) => feature.id),
          integrations: ["shadcn", "react-native"],
        }),
      );
      for (const recipe of generated.recipes) {
        expect(names.has(recipe.replace("@permdock/", ""))).toBe(true);
      }
    }
  });
});
