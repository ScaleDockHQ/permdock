import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("permdock/package.json", () => {
  it("resolves through the exports map to the package manifest", () => {
    const resolved = require.resolve("permdock/package.json");
    expect(resolved).toBe(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
    );
    const manifest: unknown = JSON.parse(readFileSync(resolved, "utf8"));
    expect(manifest).toMatchObject({ name: "permdock" });
  });
});
