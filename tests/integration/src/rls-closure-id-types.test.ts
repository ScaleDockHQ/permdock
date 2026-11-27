import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

async function generateIn(fixture: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-closure-types-"));
  try {
    const result = await rlsGenerate(
      ["--target", "sql", "--out", join(dir, "rls.sql")],
      { cwd: join(HERE, "../fixtures", fixture) },
    );
    expect(result.code).toBe(0);
    return `${result.stdout}${result.stderr}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("closure id types", () => {
  it("warns when a walked resource's ids do not compare as text", async () => {
    expect(await generateIn("file-tree-numeric")).toContain(
      "rls.idTypes: fileNode ids are numeric, and permdock_closure compares ids as text",
    );
  });

  it("stays quiet for uuid ids", async () => {
    expect(await generateIn("file-tree-scale")).not.toContain(
      "permdock_closure compares ids as text",
    );
  });
});
