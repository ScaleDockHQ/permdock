import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runRlsGenerate } from "../../src/cli/rls/generate.ts";

const CWD = join(import.meta.dirname, "fixtures/mini-app");

describe("rls generate golden parts", () => {
  it("emits one definition per helper signature", async () => {
    const outcome = await runRlsGenerate({
      cwd: CWD,
      config: {
        policy: "./src/policy.ts",
        permissions: "./src/permissions.ts",
      },
      target: "sql",
      dialect: "supabase",
      rbac: false,
      check: false,
      skipClosures: false,
      inlineFunctions: false,
      write: false,
      io: {
        stdout() {
          return undefined;
        },
        stderr() {
          return undefined;
        },
      },
    });
    expect(outcome.code).toBe(0);
    const signatures = outcome.text
      .split("\n")
      .filter((line) =>
        /^create (or replace )?(function|policy|table)/u.test(line),
      )
      .toSorted();
    await expect(signatures).toMatchFileSnapshot(
      "__snapshots__/rls-golden-signatures.txt",
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});
