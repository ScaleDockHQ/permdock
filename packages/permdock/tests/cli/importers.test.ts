import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Permission, Policy } from "../../src/index.ts";

import {
  importCasbin,
  readCasbinModel,
  runCasbinImport,
} from "../../src/cli/importers/casbin.ts";
import { importCasl, runCaslImport } from "../../src/cli/importers/casl.ts";
import { createPermDock } from "../../src/index.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(path.join(TMP, "importers-"));
const SRC = path.join(import.meta.dirname, "../../src/index.ts");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function dir(): string {
  counter += 1;
  const created = path.join(root, String(counter));
  mkdirSync(created, { recursive: true });
  return created;
}

type Generated = {
  readonly permissions: Readonly<
    Record<string, Readonly<Record<string, Permission>>>
  >;
  readonly policy: Policy<{
    readonly id: string;
    readonly roles: readonly string[];
  }>;
  readonly assignments?: readonly unknown[];
};

/** One generated permission, by action; a missing one fails the test. */
function leaf(
  group: Readonly<Record<string, Permission>>,
  action: string,
): Permission {
  const found = group[action];
  if (found === undefined) {
    throw new Error(`no ${action} permission was generated`);
  }
  return found;
}

/** Imports the generated module with its `permdock` import pointed at the source. */
async function load(file: string): Promise<Generated> {
  const local = file.replace(/\.ts$/u, ".local.ts");
  writeFileSync(
    local,
    readFileSync(file, "utf8").replace("from 'permdock'", `from '${SRC}'`),
  );
  // SAFETY: the generated module exports permissions and policy, and assignments for casbin.
  return (await import(local)) as Generated;
}

describe("casl import", () => {
  const rules = {
    editor: [
      { action: "read", subject: "Post" },
      {
        action: ["update", "delete"],
        subject: "Post",
        conditions: { authorId: "${user.id}" },
      },
      {
        action: "delete",
        subject: "Post",
        inverted: true,
        conditions: { locked: true },
      },
      {
        action: "update",
        subject: "Post",
        fields: ["title"],
        conditions: { status: { $in: ["draft", "review"] } },
      },
    ],
    admin: [["manage", "all"]],
    guest: [
      {
        action: "read",
        subject: "Post",
        conditions: { title: { $regex: "^a" } },
      },
      {
        action: "read",
        subject: "Post",
        inverted: true,
        conditions: { tags: { $all: ["x"] } },
      },
      { action: "publish-now", subject: "Post" },
      { subject: "Post" },
    ],
  };

  it("imports allows, denies, fields and the portable conditions, and reports the rest", () => {
    const imported = importCasl(rules);
    expect(
      imported.skipped.map((item) => [item.role, item.rule, item.reason]),
    ).toEqual([
      ["guest", 3, "not-a-rule"],
      ["guest", 0, "unsupported-condition"],
      ["guest", 1, "deny-widened"],
      ["guest", 2, "not-an-identifier"],
    ]);
    expect([...(imported.actions.get("post") ?? [])].toSorted()).toEqual([
      "delete",
      "read",
      "update",
    ]);
  });

  it("writes a module whose policy decides like the rules", async () => {
    const cwd = dir();
    writeFileSync(path.join(cwd, "rules.json"), JSON.stringify(rules));
    const result = runCaslImport({
      cwd,
      rules: "rules.json",
      out: "src/policy.ts",
      json: false,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("casl import: wrote 3 role(s)");
    const { permissions, policy } = await load(path.join(cwd, "src/policy.ts"));
    const post = permissions["post"] ?? {};
    const editor = createPermDock(policy, { id: "u1", roles: ["editor"] });
    const own = {
      id: "p1",
      authorId: "u1",
      locked: false,
      status: "published",
    };
    const draft = { id: "p2", authorId: "u2", locked: false, status: "draft" };
    const locked = { ...own, locked: true };
    expect([
      editor.can(leaf(post, "read"), own),
      editor.can(leaf(post, "update"), own),
      editor.can(leaf(post, "update"), draft, { field: "title" }),
      editor.can(leaf(post, "update"), draft, { field: "body" }),
      editor.can(leaf(post, "delete"), own),
      editor.can(leaf(post, "delete"), locked),
      editor.can(leaf(post, "delete"), draft),
    ]).toEqual([true, true, true, false, true, false, false]);
    const guest = createPermDock(policy, { id: "u3", roles: ["guest"] });
    expect(guest.can(leaf(post, "read"), own)).toBe(false);
    const admin = createPermDock(policy, { id: "u4", roles: ["admin"] });
    expect(admin.can(leaf(post, "delete"), locked)).toBe(true);
  });

  it("answers 2 for a missing or malformed rules file", () => {
    const cwd = dir();
    writeFileSync(path.join(cwd, "bad.json"), JSON.stringify({ editor: {} }));
    expect(
      runCaslImport({ cwd, rules: undefined, out: "x.ts", json: false }).code,
    ).toBe(2);
    expect(
      runCaslImport({ cwd, rules: "nope.json", out: "x.ts", json: false }).code,
    ).toBe(2);
    expect(
      runCaslImport({ cwd, rules: "bad.json", out: "x.ts", json: false }).code,
    ).toBe(2);
  });
});

const RBAC = `[request_definition]
r = sub, obj, act

[policy_definition]
p = sub, obj, act, eft

[role_definition]
g = _, _

[policy_effect]
e = some(where (p.eft == allow)) && !some(where (p.eft == deny))

[matchers]
m = g(r.sub, p.sub) && r.obj == p.obj && r.act == p.act
`;

describe("casbin import", () => {
  const policyCsv = `p, viewer, report, read, allow
p, editor, report, write, allow
p, editor, report, delete, deny
p, alice, report, export, allow
p, editor, /reports/*, read, allow
g, editor, viewer
g, alice, editor
g, bob, viewer
`;

  it("reads RBAC and refuses a matcher it cannot translate", () => {
    expect(readCasbinModel(RBAC)).toEqual({
      domains: false,
      roles: true,
      denies: true,
    });
    expect(
      readCasbinModel(RBAC.replace("r.act == p.act", "keyMatch(r.obj, p.obj)")),
    ).toMatchObject({
      refused: expect.stringContaining("keyMatch(r.obj,p.obj)"),
    });
  });

  it("flattens role inheritance, keeps users as assignments and reports user grants", () => {
    const model = readCasbinModel(RBAC);
    if ("refused" in model) {
      throw new Error(model.refused);
    }
    const imported = importCasbin(model, policyCsv);
    expect(imported.assignments).toEqual([
      { user: "alice", role: "editor" },
      { user: "bob", role: "viewer" },
    ]);
    expect(imported.skipped.map((item) => [item.line, item.reason])).toEqual([
      [4, "user-grant"],
      [5, "not-an-identifier"],
    ]);
  });

  it("writes a module whose policy decides like the model", async () => {
    const cwd = dir();
    writeFileSync(path.join(cwd, "model.conf"), RBAC);
    writeFileSync(path.join(cwd, "policy.csv"), policyCsv);
    const result = runCasbinImport({
      cwd,
      model: "model.conf",
      policy: "policy.csv",
      out: "src/policy.ts",
      json: false,
    });
    expect(result.code).toBe(0);
    const { permissions, policy, assignments } = await load(
      path.join(cwd, "src/policy.ts"),
    );
    const report = permissions["report"] ?? {};
    const editor = createPermDock(policy, { id: "alice", roles: ["editor"] });
    const viewer = createPermDock(policy, { id: "bob", roles: ["viewer"] });
    const row = { id: "r1" };
    expect([
      editor.can(leaf(report, "read"), row),
      editor.can(leaf(report, "write"), row),
      editor.can(leaf(report, "delete"), row),
      viewer.can(leaf(report, "write"), row),
    ]).toEqual([true, true, false, false]);
    expect(assignments).toHaveLength(2);
  });

  it("exits 1 when a deny line does not import", () => {
    const cwd = dir();
    writeFileSync(path.join(cwd, "model.conf"), RBAC);
    writeFileSync(
      path.join(cwd, "policy.csv"),
      "p, editor, /x/*, read, deny\ng, alice, editor\n",
    );
    const result = runCasbinImport({
      cwd,
      model: "model.conf",
      policy: "policy.csv",
      out: "p.ts",
      json: true,
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      skipped: [{ reason: "not-an-identifier", deny: true }],
    });
  });
});
