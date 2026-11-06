import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { codemod } from "../../src/cli/codemod/codemod.ts";

const dirs: string[] = [];

describe("codemod 0.26", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites a stored catalog-v1 document to catalog-v2", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-codemod-"));
    dirs.push(cwd);
    writeFileSync(
      join(cwd, "permissions.catalog.json"),
      `${JSON.stringify(
        {
          $schema: "https://permdock.com/schemas/catalog-v1.json",
          version: 1,
          generatedAt: "2026-01-01T00:00:00.000Z",
          generator: "permdock@0.25.0",
          resources: { post: { id: "id", schema: null } },
          permissions: [],
          grants: [
            {
              permission: "post.read",
              approval: { mode: "sequential", distinct: false, by: "admin" },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const report = codemod({
      cwd,
      version: "0.26",
      paths: ["."],
      dryRun: false,
      json: false,
    });
    expect(report.files).toHaveLength(1);
    // SAFETY: the catalog this test just wrote is a JSON object.
    const written = JSON.parse(
      readFileSync(join(cwd, "permissions.catalog.json"), "utf8"),
    ) as {
      readonly version: number;
      readonly $schema: string;
      readonly grants: readonly {
        readonly approval: Record<string, unknown>;
      }[];
    };
    expect(written.version).toBe(2);
    expect(written.$schema).toBe(
      "https://permdock.com/schemas/catalog-v2.json",
    );
    expect(written.grants[0]?.approval).toStrictEqual({
      combine: "sequential",
      mode: "confirm",
      by: "admin",
    });
  });
});
