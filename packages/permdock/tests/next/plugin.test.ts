import { describe, expect, it } from "vitest";

import { createPermDockPlugin } from "../../src/next/plugin.ts";

describe("permdock/next/plugin", () => {
  it("returns a Next config function that resolves the wrapped config", async () => {
    const withPermDock = createPermDockPlugin({ onDrift: "warn" });
    const config = withPermDock(async (phase: string) => ({ phase }));
    await expect(config("phase-production-server", {})).resolves.toStrictEqual({
      phase: "phase-production-server",
    });
    await expect(
      withPermDock({ reactStrictMode: true })("phase-export", {}),
    ).resolves.toStrictEqual({ reactStrictMode: true });
  });
});
