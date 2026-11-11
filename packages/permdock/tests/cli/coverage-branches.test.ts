import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CatalogDiff } from "../../src/cli/diff/diff.ts";
import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type { RlsGrant } from "../../src/cli/sql/grants.ts";

import { formatText } from "../../src/cli/diff/format.ts";
import { loadFixtures } from "../../src/cli/fixtures.ts";
import {
  accessSql,
  conditionSql,
} from "../../src/cli/powersync/stream-condition.ts";
import { POWERSYNC } from "../../src/cli/powersync/stream-types.ts";
import { runSkills, runSkillsInstall } from "../../src/cli/skills.ts";
import { compileConditionSql } from "../../src/cli/sql/conditions.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const dirs: string[] = [];

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-branches-"));
  dirs.push(cwd);
  return cwd;
}

describe("remaining branch paths", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a claims-change fixture whose roles are not strings", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "bad.json"),
      JSON.stringify([
        { subject: { id: "u1" }, after: { roles: [1] }, expected: "changed" },
      ]),
    );
    await expect(loadFixtures(cwd, "bad.json", true)).rejects.toThrow(
      'expected "changed"',
    );
  });

  it("walks a skill directory and skips a symlink", () => {
    const cwd = project();
    const bundled = join(cwd, "bundled");
    mkdirSync(join(bundled, "demo"), { recursive: true });
    writeFileSync(join(bundled, "demo", "SKILL.md"), "# demo\n");
    symlinkSync(join(bundled, "demo", "SKILL.md"), join(bundled, "link"));
    const result = runSkillsInstall({ cwd, agents: [], bundled });
    expect(result.code).toBe(0);
    expect(result.output).toContain("installed");
  });

  it("prints renamed permissions and added levels", () => {
    const diff: CatalogDiff = {
      a: { source: "a.json" },
      b: { source: "b.json" },
      permissions: {
        added: [],
        removed: [],
        renamed: [{ from: "note.read", to: "note.view" }],
      },
      levels: {
        added: [{ permission: "note.read", level: "own" }],
        removed: [{ permission: "note.read", level: "all" }],
      },
      scopes: { added: [], removed: [] },
      roles: { added: [], removed: [], changed: ["reader"] },
      operations: [],
      breaking: [],
    };
    const text = formatText(diff);
    expect(text).toContain("note.read → note.view");
    expect(text).toContain("note.read@own");
    expect(text).toContain("note.read@all");
    expect(text).toContain("reader: declaration changed");
  });

  it("refuses an unknown skill agent and command, and checks installed files", () => {
    const cwd = project();
    const unknown = runSkills({ cwd, action: "list", agents: ["zzzz"] });
    expect(unknown.code).toBe(2);
    expect(unknown.output).toContain("unknown --for 'zzzz'");
    expect(unknown.output).not.toContain("Did you mean");
    const command = runSkills({ cwd, action: "nope", agents: [] });
    expect(command.code).toBe(2);
    expect(command.output).toContain("unknown skills command 'nope'");
    const checked = runSkills({
      cwd,
      action: "install",
      agents: ["agent"],
      check: true,
    });
    expect(checked.code === 0 || checked.code === 1).toBe(true);
  });

  it("refuses actor and keyless role access, and a related stream with no permission", () => {
    const permissions = definePermissions({
      note: resource({ actions: ["read"] }),
    });
    const policy = definePolicy(permissions, {
      subject: () => null,
      roles: [role("reader", [allow(permissions.note.read)])],
    });
    const ctx = {
      policy,
      config: {},
      scopes: policy.scopes,
      kinds: {},
      dialect: POWERSYNC,
      sources: [],
      grants: [],
      depth: 0,
      gaps: [],
    };
    const keyless = {
      ...ctx,
      policy: { ...policy, scopes: [{ name: "org" }] },
    };
    // SAFETY: accessSql reads access, label and the permission key only.
    const grant = {
      label: "reader",
      grant: { permission: permissions.note.read },
    } as unknown as RlsGrant;
    expect(
      accessSql(
        { ...grant, access: { kind: "actor", actor: "oauth-client" } },
        "notes",
        ctx,
      ),
    ).toBe("actor grantees are not in the sync token");
    expect(
      accessSql(
        { ...grant, access: { kind: "role", role: "reader", scope: "org" } },
        "notes",
        keyless,
      ),
    ).toBe("scope org has no row key");
    expect(
      conditionSql(
        {
          op: "related",
          resource: "note",
          relation: "viewer",
          field: "note_id",
          depth: 0,
        },
        "notes",
        ctx,
      ),
    ).toBeUndefined();
    expect(conditionSql({ op: "liveSession" }, "notes", ctx)).toBeUndefined();
  });

  it("compiles a claim inside an array without a column type", () => {
    const ctx: RlsSqlContext = {
      dialect: "supabase",
      scopes: [{ name: "org", key: "org_id" }],
      tenantClaim: "org_id",
      gucPrefix: "app",
    };
    const sql = compileConditionSql(
      { op: "eq", field: "tags", value: [{ ref: "principal.claim.org" }] },
      ctx,
    );
    expect(sql).toContain("auth.jwt()");
    expect(sql).toContain("array[");
  });
});
