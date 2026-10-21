import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import type { CatalogDiff } from "../../src/cli/diff/diff.ts";
import type { CatalogDocument } from "../../src/cli/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { jsonData } from "./envelope.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/diff-app");
const TMP = join(HERE, "../../tmp");
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "diff-"));
  temps.push(dir);
  return dir;
}

async function diff(...args: readonly string[]) {
  return run(["diff", ...args, "--cwd", FIXTURE]);
}

function parsedCatalog(stdout: string): CatalogDocument {
  // SAFETY: `catalog` prints a catalog document.
  return JSON.parse(stdout) as CatalogDocument;
}

function parsed(stdout: string): CatalogDiff {
  // SAFETY: `diff --json` prints a CatalogDiff as the envelope data.
  return jsonData(stdout) as CatalogDiff;
}

describe("permdock diff", () => {
  it("needs two inputs", async () => {
    const result = await diff("src/policy-before.ts");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("two inputs");
  });

  it("exits 2 when an input is missing", async () => {
    const result = await diff("src/policy-before.ts", "src/nope.ts");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not found: src/nope.ts");
  });

  it("reports no changes and exits 0 for the same policy", async () => {
    const result = await diff("src/policy-before.ts", "src/policy-before.ts");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("no changes\n");
  });

  it("lists roles and grants that changed and exits 1 on a breaking change", async () => {
    const result = await diff(
      "src/policy-before.ts",
      "src/policy-after.ts",
      "--json",
    );
    expect(result.code).toBe(1);
    const report = parsed(result.stdout);
    expect(report.permissions).toStrictEqual({
      added: [],
      removed: [],
      renamed: [],
    });
    expect(report.roles).toStrictEqual({
      added: [],
      removed: ["auditor"],
      changed: ["admin"],
    });
    expect(report.grants?.added.map((grant) => grant.permission)).toStrictEqual(
      ["post.archive", "post.read"],
    );
    expect(
      report.grants?.removed.map((grant) => [grant.role, grant.permission]),
    ).toStrictEqual([
      ["admin", "post.archive"],
      ["member", "post.publish"],
      ["auditor", "post.read"],
    ]);
    expect(
      report.grants?.changed.map((change) => [
        change.after.permission,
        change.changes,
      ]),
    ).toStrictEqual([
      ["post.delete", ["approval added"]],
      ["post.update", ["where removed"]],
    ]);
    expect(report.breaking.map((change) => change.kind)).toStrictEqual([
      "role-removed",
      "allow-removed",
      "deny-added",
      "allow-narrowed",
    ]);
    expect(report.breaking.map((change) => change.detail)).toContain(
      "allow post.publish (role member) removed",
    );
  });

  it("prints the text form with a breaking section", async () => {
    const result = await diff("src/policy-before.ts", "src/policy-after.ts");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("roles\n  - auditor\n  ~ admin");
    expect(result.stdout).toContain("+ deny post.read (role member)");
    expect(result.stdout).toContain(
      "~ allow post.delete (role member): approval added",
    );
    expect(result.stdout).toMatch(/breaking \(4\)\n/u);
  });

  it("exits 0 for a widening-only change", async () => {
    const result = await diff(
      "src/policy-before.ts",
      "src/policy-wider.ts",
      "--json",
    );
    expect(result.code).toBe(0);
    const report = parsed(result.stdout);
    expect(report.roles.added).toStrictEqual(["viewer"]);
    expect(report.grants?.added.map((grant) => grant.permission)).toStrictEqual(
      ["post.create", "post.read"],
    );
    expect(report.breaking).toStrictEqual([]);
  });

  it("treats an added delegation as safe and a removed or narrowed one as breaking", async () => {
    const added = await diff(
      "src/policy-before.ts",
      "src/policy-delegated.ts",
      "--json",
    );
    expect(added.code).toBe(0);
    expect(parsed(added.stdout).delegations).toStrictEqual({
      added: [
        {
          from: { kind: "role", role: "member", scope: "global" },
          to: { kind: "eve" },
          permissions: ["post.read", "post.update"],
        },
      ],
      removed: [],
      changed: [],
    });

    const removed = await diff(
      "src/policy-delegated.ts",
      "src/policy-before.ts",
      "--json",
    );
    expect(removed.code).toBe(1);
    expect(parsed(removed.stdout).breaking).toStrictEqual([
      {
        kind: "delegation-removed",
        detail: expect.stringContaining(
          "→ eve (post.read, post.update) removed",
        ),
      },
    ]);

    const narrowed = await diff(
      "src/policy-delegated.ts",
      "src/policy-delegated-less.ts",
    );
    expect(narrowed.code).toBe(1);
    expect(narrowed.stdout).toContain(
      'delegation-narrowed: delegation {"kind":"role","role":"member","scope":"global"} → eve (post.read): permissions removed: post.update, validity narrowed',
    );

    const widened = await diff(
      "src/policy-delegated-less.ts",
      "src/policy-delegated.ts",
      "--json",
    );
    expect(widened.code).toBe(0);
    expect(
      parsed(widened.stdout).delegations?.changed[0]?.changes,
    ).toStrictEqual(["permissions added: post.update", "validity widened"]);
  });

  it("flags the reverse of a narrowing as a widening and the reverse of a widening as breaking", async () => {
    const result = await diff(
      "src/policy-after.ts",
      "src/policy-before.ts",
      "--json",
    );
    expect(result.code).toBe(1);
    const report = parsed(result.stdout);
    expect(
      report.grants?.changed.map((change) => [
        change.after.permission,
        change.changes,
      ]),
    ).toStrictEqual([
      ["post.delete", ["approval removed"]],
      ["post.update", ["where added"]],
    ]);
    expect(report.breaking.map((change) => change.kind)).toStrictEqual([
      "allow-removed",
      "deny-added",
      "allow-narrowed",
    ]);
  });

  it("prints operation findings in the text report and exits 0", async () => {
    const catalog = await run([
      "catalog",
      "--permissions",
      "src/permissions.ts",
      "--cwd",
      FIXTURE,
    ]);
    const base = parsedCatalog(catalog.stdout);
    const key = base.permissions[0]?.key ?? "";
    const dir = tempDir();
    const write = (name: string, risk: "low" | "critical"): string => {
      const file = join(dir, name);
      writeFileSync(
        file,
        JSON.stringify({
          ...base,
          operations: [{ name: "readPost", permission: key, meta: { risk } }],
        }),
      );
      return file;
    };
    const result = await diff(
      write("before.json", "low"),
      write("after.json", "critical"),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `operations\n  ~ readPost (${key}): risk low → critical\n`,
    );
    const [first, ...rest] = base.permissions;
    const approved = (name: string, approvals: readonly string[]): string => {
      const file = join(dir, name);
      writeFileSync(
        file,
        JSON.stringify({
          ...base,
          permissions: [{ ...first, approvals }, ...rest],
          operations: [{ name: "readPost", permission: key, meta: {} }],
        }),
      );
      return file;
    };
    const unapproved = await diff(
      approved("gated.json", ["human"]),
      approved("open.json", []),
    );
    expect(unapproved.stdout).toBe(
      `operations\n  ~ readPost (${key}): approval no longer required\n`,
    );
  });

  it("reads a committed catalog on one side", async () => {
    const catalog = await run([
      "catalog",
      "--permissions",
      "src/permissions.ts",
      "--cwd",
      FIXTURE,
    ]);
    expect(catalog.code).toBe(0);
    const dir = tempDir();
    const file = join(dir, "permissions.catalog.json");
    // A catalog built without its policy has neither grants nor role details.
    const {
      grants: _grants,
      roles: _roles,
      ...bare
    } = parsedCatalog(catalog.stdout);
    writeFileSync(file, JSON.stringify(bare));
    const result = await diff(file, "src/policy-before.ts");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("grants: not compared");
    expect(result.stdout).toContain(
      "roles\n  + admin\n  + auditor\n  + member",
    );
  });

  it("refuses --impact over a catalog file", async () => {
    const dir = tempDir();
    const file = join(dir, "permissions.catalog.json");
    const catalog = await run([
      "catalog",
      "--permissions",
      "src/permissions.ts",
      "--cwd",
      FIXTURE,
    ]);
    writeFileSync(file, catalog.stdout);
    const result = await diff(file, "src/policy-after.ts", "--impact");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--impact needs two policy modules");
  });

  it("runs the fixtures through both policies with --impact", async () => {
    const result = await diff(
      "src/policy-before.ts",
      "src/policy-after.ts",
      "--impact",
      "--json",
    );
    expect(result.code).toBe(1);
    const report = parsed(result.stdout);
    expect(report.impact).toStrictEqual([
      {
        action: "post.publish",
        subject: "u1",
        before: "granted",
        after: "denied",
      },
      {
        action: "post.delete",
        subject: "u1",
        before: "granted",
        after: "approval-required",
      },
      {
        action: "post.update",
        subject: "u2",
        before: "denied",
        after: "granted",
      },
    ]);
    expect(
      report.breaking.filter((change) => change.kind === "access-lost"),
    ).toStrictEqual([
      {
        kind: "access-lost",
        permission: "post.publish",
        detail: "u1 loses post.publish: granted → denied",
      },
      {
        kind: "access-lost",
        permission: "post.delete",
        detail: "u1 loses post.delete: granted → approval-required",
      },
    ]);
  });

  it("accepts --impact before the inputs and a --fixtures path", async () => {
    const result = await diff(
      "--impact",
      "src/policy-before.ts",
      "src/policy-after.ts",
      "--fixtures",
      "fixtures.json",
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("impact (3 fixture(s) change outcome)");
    expect(result.stdout).toContain(
      "u1 post.delete: granted → approval-required",
    );
  });

  it("reports no outcome change for the same policy and names the tenant of a row", async () => {
    const same = await diff(
      "src/policy-before.ts",
      "src/policy-before.ts",
      "--impact",
      "--fixtures",
      "fixtures.json",
    );
    expect(same.code).toBe(0);
    expect(same.stdout).toContain("impact: no fixture changes outcome");
    const dir = tempDir();
    const file = join(dir, "fixtures.json");
    writeFileSync(
      file,
      JSON.stringify({
        fixtures: [
          {
            subject: { id: "u1", roles: ["member"], tenant: "o1" },
            row: { id: "p1", authorId: "u1", orgId: "o1" },
            action: "post.publish",
          },
          {
            subject: { id: "u1", roles: ["member"] },
            row: { id: "p1" },
            action: "post.unknown",
          },
        ],
      }),
    );
    const result = await diff(
      "src/policy-before.ts",
      "src/policy-after.ts",
      "--impact",
      "--fixtures",
      file,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(parsed(result.stdout).impact).toStrictEqual([
      {
        action: "post.publish",
        subject: "u1",
        tenant: "o1",
        before: "granted",
        after: "denied",
      },
    ]);
    const text = await diff(
      "src/policy-before.ts",
      "src/policy-after.ts",
      "--impact",
      "--fixtures",
      file,
    );
    expect(text.stdout).toContain("u1 in o1 post.publish: granted → denied");
  });

  it("exits 2 when the fixtures file cannot be read", async () => {
    const result = await diff(
      "src/policy-before.ts",
      "src/policy-after.ts",
      "--impact",
      "--fixtures",
      "missing.fixtures.json",
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("missing.fixtures.json");
  });
});
