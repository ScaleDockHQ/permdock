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

import { run } from "../../src/cli/core/run.ts";
import {
  importCasbin,
  readCasbinModel,
  runCasbinImport,
} from "../../src/cli/importers/casbin.ts";
import { importCasl, runCaslImport } from "../../src/cli/importers/casl.ts";
import { getPermDockSync } from "../../src/index.ts";

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

/**
 * Imports the generated module with its `permdock` import pointed at the
 * source.
 */
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
    ).toStrictEqual([
      ["guest", 3, "not-a-rule"],
      ["guest", 0, "unsupported-condition"],
      ["guest", 1, "deny-widened"],
      ["guest", 2, "not-an-identifier"],
    ]);
    expect([...(imported.actions.get("post") ?? [])].toSorted()).toStrictEqual([
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
    const editor = getPermDockSync(policy, { id: "u1", roles: ["editor"] });
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
    ]).toStrictEqual([true, true, true, false, true, false, false]);
    const guest = getPermDockSync(policy, { id: "u3", roles: ["guest"] });
    expect(guest.can(leaf(post, "read"), own)).toBe(false);
    const admin = getPermDockSync(policy, { id: "u4", roles: ["admin"] });
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
    expect(readCasbinModel(RBAC)).toStrictEqual({
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
    expect(imported.assignments).toStrictEqual([
      { user: "alice", role: "editor" },
      { user: "bob", role: "viewer" },
    ]);
    expect(
      imported.skipped.map((item) => [item.line, item.reason]),
    ).toStrictEqual([
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
    const editor = getPermDockSync(policy, { id: "alice", roles: ["editor"] });
    const viewer = getPermDockSync(policy, { id: "bob", roles: ["viewer"] });
    const row = { id: "r1" };
    expect([
      editor.can(leaf(report, "read"), row),
      editor.can(leaf(report, "write"), row),
      editor.can(leaf(report, "delete"), row),
      viewer.can(leaf(report, "write"), row),
    ]).toStrictEqual([true, true, false, false]);
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

describe("casl conditions and rule shapes", () => {
  it("reads packed rules, logical operators, comparisons, $exists and arrays", () => {
    const imported = importCasl({
      ops: [
        ["read,update", "Invoice", { total: { $gte: 10, $lt: 100 } }],
        [
          "read",
          "Invoice",
          { $or: [{ status: "open" }, { status: { $ne: "void" } }] },
          1,
        ],
        [
          "delete",
          "Invoice",
          {
            $and: [{ archived: { $exists: false } }],
            $nor: [{ owner: "${user.orgId}" }],
          },
          0,
          "total,status",
        ],
        {
          action: "read",
          subject: ["Invoice", "Receipt"],
          conditions: { tags: ["a", 1, null, true] },
        },
        {
          action: "list",
          subject: "Receipt",
          conditions: {
            amount: { $in: [1, 2], $nin: [3], $gt: 0, $lte: 9, $eq: 5 },
          },
        },
        {
          action: "read",
          subject: "Receipt",
          conditions: { meta: { nested: { deep: 1 } } },
        },
        { action: "read", subject: "Receipt", conditions: { "author.id": 1 } },
        { action: "read", subject: "Receipt", conditions: { $where: "x" } },
        { action: "read", subject: "Receipt", conditions: { $or: "x" } },
        { action: "read", subject: "Receipt", conditions: { $or: [1] } },
        {
          action: "read",
          subject: "Receipt",
          conditions: { owner: [{ id: 1 }] },
        },
        {
          action: "read",
          subject: "Receipt",
          conditions: { $and: [{ x: { $regex: "y" } }] },
        },
        { action: 1 },
        { action: "read", subject: 2 },
      ],
    });
    expect(
      imported.skipped.map((item) => [item.rule, item.reason]),
    ).toStrictEqual([
      [12, "not-a-rule"],
      [13, "not-a-rule"],
      [5, "unsupported-condition"],
      [6, "unsupported-condition"],
      [7, "unsupported-condition"],
      [8, "unsupported-condition"],
      [9, "unsupported-condition"],
      [10, "unsupported-condition"],
      [11, "unsupported-condition"],
    ]);
    const grants = imported.roles[0]?.grants ?? [];
    expect(
      grants.map(
        (grant) => `${grant.effect} ${grant.resource}.${grant.action}`,
      ),
    ).toStrictEqual([
      "allow invoice.read",
      "allow invoice.update",
      "deny invoice.read",
      "allow invoice.delete",
      "allow invoice.read",
      "allow receipt.read",
      "allow receipt.list",
    ]);
    expect(grants[3]).toMatchObject({ fields: ["total", "status"] });
  });

  it("expands manage to CRUD for a subject the rules give no action", () => {
    const imported = importCasl({
      admin: [{ action: "manage", subject: "Report" }],
    });
    expect(
      [...(imported.actions.get("report") ?? [])].toSorted(),
    ).toStrictEqual(["create", "delete", "read", "update"]);
  });

  it("renders every operator into a module the policy accepts", async () => {
    const cwd = dir();
    writeFileSync(
      path.join(cwd, "rules.json"),
      JSON.stringify({
        clerk: [
          {
            action: "read",
            subject: "Invoice",
            conditions: {
              $nor: [{ status: "void" }],
              total: {
                $gt: 1,
                $gte: 1,
                $lt: 9,
                $lte: 9,
                $ne: 5,
                $in: [1, 2],
                $nin: [3],
              },
              archived: { $exists: true },
              tag: null,
              owner: "${user.orgId}",
            },
          },
        ],
      }),
    );
    const result = runCaslImport({
      cwd,
      rules: "rules.json",
      out: "policy.ts",
      json: true,
    });
    expect(JSON.parse(result.output)).toStrictEqual({
      out: "policy.ts",
      skipped: [],
    });
    const { permissions, policy } = await load(path.join(cwd, "policy.ts"));
    const clerk = getPermDockSync(policy, { id: "u1", roles: ["clerk"] });
    const invoice = permissions["invoice"] ?? {};
    expect(
      clerk.can(leaf(invoice, "read"), {
        id: "i1",
        status: "open",
        total: 2,
        archived: true,
        tag: null,
        owner: "o1",
      }),
    ).toBe(false);
  });

  it("answers 2 for a file that is not JSON", () => {
    const cwd = dir();
    writeFileSync(path.join(cwd, "rules.json"), "{");
    expect(
      runCaslImport({ cwd, rules: "rules.json", out: "x.ts", json: false }),
    ).toMatchObject({ code: 2 });
  });
});

const DOMAINS = `[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act

[role_definition]
g = _, _, _

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = g(r.sub, p.sub, r.dom) && r.dom == p.dom && r.obj == p.obj && r.act == p.act
`;

describe("casbin models and lines", () => {
  it("refuses request, policy and effect shapes it cannot translate", () => {
    expect(
      readCasbinModel(RBAC.replace("r = sub, obj, act", "r = sub, obj")),
    ).toMatchObject({ refused: expect.stringContaining("r = sub, obj") });
    expect(
      readCasbinModel(RBAC.replace("p = sub, obj, act, eft", "p = sub, act")),
    ).toMatchObject({ refused: expect.stringContaining("p = sub, act") });
    expect(
      readCasbinModel(RBAC.replace(/e = .*/u, "e = priority(p.eft) || deny")),
    ).toMatchObject({ refused: expect.stringContaining("e = priority") });
    expect(readCasbinModel(RBAC.replace(/m = .*/u, "m = "))).toMatchObject({
      refused: expect.stringContaining("(empty)"),
    });
  });

  it("imports wildcard-domain grants and reports domain, malformed and effect-less deny lines", () => {
    const model = readCasbinModel(DOMAINS);
    expect(model).toStrictEqual({ domains: true, roles: true, denies: false });
    if ("refused" in model) {
      throw new Error(model.refused);
    }
    const imported = importCasbin(
      model,
      `# a comment
p, admin, *, invoice, read
p, admin, t1, invoice, update
p, admin, *, invoice
p, admin, *, invoice, delete, deny
g, alice, admin, t1
g, admin
g, owner, admin
g, admin, owner
`,
    );
    expect(imported.assignments).toStrictEqual([
      { user: "alice", role: "admin", domain: "t1" },
    ]);
    expect(
      imported.skipped.map((item) => [item.line, item.reason]),
    ).toStrictEqual([
      [7, "malformed"],
      [3, "domain-grant"],
      [4, "malformed"],
      [5, "deny-without-effect"],
    ]);
    expect(
      imported.roles.map((role) => [role.name, role.grants.length]),
    ).toStrictEqual([
      ["admin", 1],
      ["owner", 1],
    ]);
  });

  it("answers 2 for missing files and a refused model, and prints a summary", () => {
    const cwd = dir();
    writeFileSync(
      path.join(cwd, "model.conf"),
      RBAC.replace(/m = .*/u, "m = true"),
    );
    writeFileSync(path.join(cwd, "policy.csv"), "");
    expect(
      runCasbinImport({
        cwd,
        model: undefined,
        policy: "policy.csv",
        out: "p.ts",
        json: false,
      }).code,
    ).toBe(2);
    expect(
      runCasbinImport({
        cwd,
        model: "model.conf",
        policy: "nope.csv",
        out: "p.ts",
        json: false,
      }).code,
    ).toBe(2);
    expect(
      runCasbinImport({
        cwd,
        model: "model.conf",
        policy: "policy.csv",
        out: undefined,
        json: false,
      }).code,
    ).toBe(2);
    expect(
      runCasbinImport({
        cwd,
        model: "model.conf",
        policy: "policy.csv",
        out: "p.ts",
        json: false,
      }),
    ).toMatchObject({
      code: 2,
      output: expect.stringContaining("casbin import --model"),
    });
    writeFileSync(path.join(cwd, "model.conf"), RBAC);
    writeFileSync(path.join(cwd, "policy.csv"), "p, alice, report, read\n");
    expect(
      runCasbinImport({
        cwd,
        model: "model.conf",
        policy: "policy.csv",
        out: "p.ts",
        json: false,
      }).output,
    ).toContain("user-grant: line 1");
  });
});

describe("casl and casbin commands", () => {
  it("run the import action and refuse any other", async () => {
    const cwd = dir();
    writeFileSync(
      path.join(cwd, "rules.json"),
      JSON.stringify({ viewer: [{ action: "read", subject: "Doc" }] }),
    );
    writeFileSync(path.join(cwd, "model.conf"), RBAC);
    writeFileSync(
      path.join(cwd, "policy.csv"),
      "p, viewer, doc, read\ng, bob, viewer\n",
    );
    const casl = await run(
      ["casl", "import", "--rules", "rules.json", "--out", "a.ts"],
      { cwd },
    );
    const casbin = await run(
      [
        "casbin",
        "import",
        "--model",
        "model.conf",
        "--policy",
        "policy.csv",
        "--out",
        "b.ts",
      ],
      { cwd },
    );
    const other = await run(["casl", "export"], { cwd });
    const otherCasbin = await run(["casbin", "export"], { cwd });
    expect([
      casl.code,
      casbin.code,
      other.code,
      otherCasbin.code,
    ]).toStrictEqual([0, 0, 2, 2]);
    expect(casl.stdout).toContain(
      "casl import: wrote 1 role(s) with 1 grant(s) to a.ts, skipped 0",
    );
    expect(casbin.stdout).toContain(
      "casbin import: wrote 1 role(s) and 1 assignment(s) to b.ts, skipped 0",
    );
  });
});

describe("casbin model and line edges", () => {
  it("refuses a model without a request, matcher or effect and ignores a line without =", () => {
    expect(readCasbinModel("[matchers]\nm = r.obj == p.obj\n")).toMatchObject({
      refused: expect.stringContaining("r = :"),
    });
    expect(
      readCasbinModel(RBAC.replace(/\[matchers\][\s\S]*/u, "")),
    ).toMatchObject({ refused: expect.stringContaining("(empty)") });
    expect(
      readCasbinModel(
        RBAC.replace(
          /\[policy_effect\]\ne = .*\n/u,
          "[policy_effect]\nnot a pair\n",
        ),
      ),
    ).toMatchObject({ refused: expect.stringContaining("e = :") });
  });

  it("reports a bare p line and prints the widened-access warning", () => {
    const model = readCasbinModel(RBAC);
    if ("refused" in model) {
      throw new Error(model.refused);
    }
    expect(importCasbin(model, "p\ng, a, viewer\n").skipped).toMatchObject([
      { line: 1, reason: "malformed" },
    ]);
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
      json: false,
    });
    expect(result).toMatchObject({
      code: 1,
      output: expect.stringContaining("a deny line did not import"),
    });
  });
});

describe("casl rule edges", () => {
  it("reports a rule without a subject and quotes a field that is not an identifier", async () => {
    const imported = importCasl({
      viewer: [
        { action: "read" },
        { action: "read", subject: "Doc", conditions: { "first-name": "a" } },
      ],
    });
    expect(imported.skipped).toMatchObject([{ rule: 0, reason: "no-subject" }]);
    const cwd = dir();
    writeFileSync(
      path.join(cwd, "rules.json"),
      JSON.stringify({
        viewer: [
          { action: "read", subject: "Doc", conditions: { "first-name": "a" } },
        ],
      }),
    );
    runCaslImport({ cwd, rules: "rules.json", out: "policy.ts", json: false });
    expect(readFileSync(path.join(cwd, "policy.ts"), "utf8")).toContain(
      "where: { 'first-name': 'a' }",
    );
  });
});
