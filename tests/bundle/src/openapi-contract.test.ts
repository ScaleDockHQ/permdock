import { describe, expect, it } from "vitest";

import { OPENAPI_CONTRACT, bundled } from "./consumers.ts";

const decoder = new TextDecoder();

describe("permdock/openapi contract helpers", () => {
  it("bundle without policy, evaluation or permission-definition code", async () => {
    const files = await bundled(OPENAPI_CONTRACT);
    const code = files.map((contents) => decoder.decode(contents)).join("\n");
    expect(code).toContain("x-permdock-permissions");
    expect(code).toContain("oauth2");
    // Every core module that validates or evaluates a policy throws a `PermDock: …` message.
    expect(code).not.toContain("PermDock:");
    expect(code).not.toMatch(/\bimport\b/u);
    expect(code.length).toBeLessThan(600);
  });
});
