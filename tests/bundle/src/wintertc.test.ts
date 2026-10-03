import { describe, expect, it } from "vitest";

import {
  CLIENT_ENTRIES,
  ENTRIES,
  WINTERTC_ENTRIES,
  policyChunks,
  serverOnlyFiles,
  walk,
  wintertcViolations,
} from "./graph.ts";

describe("WinterTC Minimum Common API", () => {
  it("loads every entry but permdock/terminal without Node built-ins", () => {
    const violations: string[] = [];
    for (const entry of WINTERTC_ENTRIES) {
      violations.push(
        ...wintertcViolations(walk(ENTRIES[entry])).map(
          (violation) => `${entry}: ${violation}`,
        ),
      );
    }
    expect(violations).toEqual([]);
  });

  it("evaluates the WinterTC entries", async () => {
    await import("permdock");
    await import("permdock/server");
  });

  it("keeps client entries off policy and server evaluation chunks", () => {
    const leaked: string[] = [];
    for (const entry of CLIENT_ENTRIES) {
      leaked.push(
        ...policyChunks(walk(ENTRIES[entry])).map(
          (file) => `${entry}: ${file}`,
        ),
      );
    }
    expect(leaked).toEqual([]);
  });

  it("keeps client entries off server adapters", () => {
    const leaked: string[] = [];
    for (const entry of CLIENT_ENTRIES) {
      leaked.push(...serverOnlyFiles(walk(ENTRIES[entry])));
    }
    expect(leaked).toEqual([]);
  });
});
