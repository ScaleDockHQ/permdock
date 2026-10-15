import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The same boundary `oxlint.config.ts` enforces, checked without the linter:
 * each adapter family takes its runtime imports from its kit and from its own
 * folder only. Type imports are erased and stay free.
 */
const FAMILIES: Readonly<
  Record<
    string,
    { readonly folders: readonly string[]; readonly kits: readonly string[] }
  >
> = {
  http: {
    folders: [
      "hono",
      "express",
      "fastify",
      "elysia",
      "nest",
      "node",
      "h3",
      "sveltekit",
      "astro",
      "solid-start",
      "tanstack-start",
      "trpc",
      "orpc",
    ],
    kits: ["../server/kit.ts", "../node/http.ts"],
  },
  agent: {
    folders: ["ai-sdk", "claude-agent", "openai", "eve"],
    kits: ["../agent/kit.ts"],
  },
  ui: {
    folders: ["react", "vue", "svelte", "solid"],
    kits: ["../client/kit.ts"],
  },
};

const SRC = new URL("../../src/", import.meta.url);
const RUNTIME_IMPORT =
  /^(?:import|export)\s+(?!type\b)(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s+"(\.\.\/[^"]+)"/gmu;

function runtimeImportsOutside(
  folder: string,
  kits: readonly string[],
): readonly string[] {
  const found: string[] = [];
  for (const file of readdirSync(new URL(`${folder}/`, SRC), {
    recursive: true,
  })) {
    const name = String(file);
    if (!/\.(?:ts|tsx|svelte|vue)$/u.test(name)) {
      continue;
    }
    const source = readFileSync(new URL(`${folder}/${name}`, SRC), "utf8");
    for (const match of source.matchAll(RUNTIME_IMPORT)) {
      const target = match[1] ?? "";
      const specifiers = match[0].slice(match[0].indexOf("{"));
      const typesOnly =
        match[0].includes("{") &&
        specifiers
          .slice(1, specifiers.indexOf("}"))
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "")
          .every((item) => item.startsWith("type "));
      if (!typesOnly && !kits.includes(target)) {
        found.push(`${folder}/${name} -> ${target}`);
      }
    }
  }
  return found;
}

describe("adapter kits", () => {
  it.each(Object.entries(FAMILIES))(
    "keeps every %s adapter's runtime imports inside its kit",
    (_family, { folders, kits }) => {
      expect(
        folders.flatMap((folder) => runtimeImportsOutside(folder, kits)),
      ).toEqual([]);
    },
  );
});
