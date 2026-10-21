import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TMP = path.join(import.meta.dirname, "../../tmp");

const temps: string[] = [];

describe("testing node test", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A `node:test` file that runs an exhaustive matrix through the built
   * `permdock/testing/core`.
   */
  function matrixFile(readCell: string): string {
    return `import assert from "node:assert/strict";
import { test } from "node:test";
import { allow, definePermissions, definePolicy, resource, role } from "permdock";
import { policyMatrix } from "permdock/testing/core";

const permissions = definePermissions({
  doc: resource({ id: "id", actions: ["read", "update"] }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("viewer", [allow(permissions.doc.read)]),
    role("editor", [allow([permissions.doc.read, permissions.doc.update])]),
  ],
  subject: (user) => (user === null ? null : { id: user.id, roles: [user.role] }),
});

test("doc policy matrix", async () => {
  const report = await policyMatrix(policy, {
    subjects: {
      vera: { id: "vera", role: "viewer" },
      ed: { id: "ed", role: "editor" },
    },
    fixtures: { doc: { id: "d1" } },
    matrix: {
      "doc.read": { vera: ${readCell}, ed: "granted" },
      "doc.update": { vera: "denied", ed: "granted" },
    },
  });
  assert.deepEqual(report.missing, []);
  for (const cell of report.cells) {
    assert.deepEqual(cell.failures, [], cell.name);
  }
});
`;
  }

  function runNodeTest(source: string): ReturnType<typeof spawnSync> {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(path.join(TMP, "node-test-"));
    temps.push(dir);
    const file = path.join(dir, "matrix.test.mjs");
    writeFileSync(file, source);
    return spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", file],
      { cwd: dir, encoding: "utf8" },
    );
  }

  describe("permdock/testing/core under node:test", () => {
    it("runs an exhaustive policy matrix without vitest", () => {
      const result = runNodeTest(matrixFile('"granted"'));
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("# pass 1");
      expect(result.status).toBe(0);
    });

    it("fails the node:test run when a cell disagrees", () => {
      const result = runNodeTest(matrixFile('"denied"'));
      expect(result.stdout).toContain("# fail 1");
      expect(result.stdout).toContain("doc.read / vera");
      expect(result.status).toBe(1);
    });
  });
});
