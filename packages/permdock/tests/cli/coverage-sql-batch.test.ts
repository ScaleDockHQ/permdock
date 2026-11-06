import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { MigrateReport } from "../../src/cli/rls/migrate.ts";
import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type { Condition } from "../../src/index.ts";

import { runRlsMigrate } from "../../src/cli/rls/migrate.ts";
import { scanSources } from "../../src/cli/scan.ts";
import { compileGrants } from "../../src/cli/sql/compile.ts";
import { compileConditionSql } from "../../src/cli/sql/conditions.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  authenticated,
  context,
  definePermissions,
  definePolicy,
  opaque,
  resource,
  role,
  sqlFunction,
} from "../../src/index.ts";

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

type GrantsPolicy = Parameters<typeof compileGrants>[0];

function compile(
  policy: GrantsPolicy,
  extra: Partial<RlsSqlContext> = {},
  options: {
    readonly skipClosures?: boolean;
    readonly rowActions?: boolean;
  } = {},
) {
  const warnings: string[] = [];
  const result = compileGrants(
    policy,
    {
      dialect: "supabase",
      tenantClaim: "tenant_id",
      scopes: scopeList(policy.scopes),
      gucPrefix: "app",
      ...extra,
    },
    undefined,
    warnings,
    options.skipClosures === true,
    options.rowActions === true,
  );
  return { ...result, warnings };
}

function withoutResource(policy: GrantsPolicy, name: string): GrantsPolicy {
  const resources = new Map(policy.resources);
  resources.delete(name);
  return { ...policy, resources };
}

function withoutId(policy: GrantsPolicy, name: string): GrantsPolicy {
  const resources = new Map(policy.resources);
  const node = resources.get(name);
  if (node === undefined) {
    throw new Error(`missing resource ${name}`);
  }
  const { id: _removed, ...rest } = node;
  // SAFETY: id is removed so membershipField falls back to "id".
  resources.set(name, rest as typeof node);
  return { ...policy, resources };
}

const folderMembers = {
  table: "folder_members",
  id: "folder_id",
  user: "user_id",
  role: "role",
} as const;

const apiKeys = {
  claim: "api_key",
  scopes: "scopes",
  tenant: "tenant",
  roles: "roles",
  serviceRoles: [],
} as const;

describe("compileGrants uncovered branches", () => {
  it("uses false when the grant resource is missing and id when the row id is missing", () => {
    const permissions = definePermissions({
      folder: resource({ actions: ["read"] }),
      file: resource({
        parent: { field: "folderId", resource: "folder" },
        actions: ["read"],
      }),
    });
    const policy = definePolicy(permissions, {
      subject: () => null,
      roles: [
        role("editor", [allow(permissions.file.read)], {
          on: permissions.folder,
        }),
        role("owner", [allow(permissions.folder.read)], {
          on: permissions.folder,
        }),
      ],
    });
    const missing = compile(withoutResource(policy, "file"), {
      memberships: { resource: { folder: folderMembers } },
    });
    expect(
      missing.branches.find((branch) => branch.permissionKey === "file.read")
        ?.access,
    ).toBe("false");
    const fallback = compile(withoutId(policy, "folder"), {
      memberships: { resource: { folder: folderMembers } },
    });
    expect(
      fallback.branches.find((branch) => branch.permissionKey === "folder.read")
        ?.access,
    ).toContain('"id" in (select m."folder_id"');
  });

  it("joins several capability hops and skips a holder that is not on the row", () => {
    const chained = definePermissions({
      project: resource({ actions: ["read"] }),
      folder: resource({
        parent: { field: "projectId", resource: "project" },
        actions: ["read"],
      }),
      file: resource({
        parent: { field: "folderId", resource: "folder" },
        actions: ["read", "update"],
      }),
    });
    const linked = definePolicy(chained, {
      subject: () => null,
      roles: [
        role(
          "commenter",
          [
            allow(chained.file.read),
            allow(chained.file.update, { where: { status: "open" } }),
          ],
          { on: chained.folder },
        ),
      ],
    });
    const compiled = compile(linked, { capabilities: true });
    const anon = (key: string) =>
      compiled.branches.find(
        (branch) =>
          branch.permissionKey === key && branch.roles.includes("anon"),
      );
    const read = anon("file.read")?.access ?? "";
    expect(read).toContain('"folderId"');
    expect(read).toContain('"projectId"');
    expect(read).toContain(" or ");
    expect(anon("file.read")?.check).toBeUndefined();
    expect(anon("file.update")?.check).toContain("'open'");

    const orphanPermissions = definePermissions({
      orphan: resource({ actions: ["read"] }),
      file: resource({ actions: ["read"] }),
    });
    const orphan = definePolicy(orphanPermissions, {
      subject: () => null,
      roles: [
        role("guest", [allow(orphanPermissions.file.read)], {
          on: orphanPermissions.orphan,
        }),
      ],
    });
    const skipped = compile(orphan, { capabilities: true });
    expect(
      skipped.branches.some((branch) => branch.roles.includes("anon")),
    ).toBe(false);
    expect(skipped.warnings.join("\n")).toContain(
      "no orphan memberships table",
    );
  });

  it("omits a missing where or check and keeps one that is set", () => {
    const permissions = definePermissions({
      folder: resource({ actions: ["read"] }),
      file: resource({
        parent: { field: "folderId", resource: "folder" },
        actions: ["export", "archive"],
      }),
    });
    const policy = definePolicy(permissions, {
      subject: () => null,
      roles: [
        role(
          "guest",
          [
            allow(permissions.file.export),
            allow(permissions.file.archive, { where: { status: "open" } }),
          ],
          { on: permissions.folder },
        ),
        role("clerk", [
          allow(permissions.file.export),
          allow(permissions.file.archive, { check: { status: "open" } }),
        ]),
      ],
    });
    const { actionBranches } = compile(
      policy,
      {
        actions: { export: "none", archive: "none" },
        memberships: { resource: { folder: folderMembers } },
      },
      { rowActions: true },
    );
    const branch = (label: string, key: string) =>
      actionBranches.find(
        (item) => item.label === label && item.permissionKey === key,
      );
    expect(branch("guest", "file.export")?.using).toBeUndefined();
    expect(branch("guest", "file.archive")?.using).toContain("'open'");
    expect(branch("clerk", "file.export")?.check).toBeUndefined();
    expect(branch("clerk", "file.archive")?.check).toContain("'open'");
  });

  it("rejects a permission key that contains @ when levels compile", () => {
    const permissions = definePermissions({
      "doc@x": resource({ actions: ["read"] }),
    });
    const policy = definePolicy(permissions, {
      subject: () => null,
      roles: [role("reader", [allow(permissions["doc@x"].read)])],
    });
    expect(() =>
      compile(policy, {
        customRoles: {
          declared: ["reader"],
          assignable: ["reader"],
          levels: true,
        },
      }),
    ).toThrow(/permission key 'doc@x.read' holds '@'/u);
  });

  it("keeps an empty level and skips a level that reads request context", () => {
    const permissions = definePermissions({
      job: resource({
        actions: ["read"],
        levels: { all: {}, own: { ip: context["ip"] } },
      }),
    });
    const policy = definePolicy(permissions, {
      subject: () => null,
      roles: [role("reader", [allow(permissions.job.read)])],
    });
    const compiled = compile(
      policy,
      {
        customRoles: {
          declared: ["reader"],
          assignable: ["reader"],
          levels: true,
        },
      },
      { skipClosures: true },
    );
    const keys = compiled.rolePermissions.map((row) => row.grantKey);
    expect(keys).toContain("job.read@all");
    expect(keys).not.toContain("job.read@own");
    expect(compiled.warnings.join("\n")).toContain("context.ip");
  });

  it("warns for sqlFunction and opaque conditions", () => {
    const permissions = definePermissions({
      note: resource({ actions: ["read", "update"] }),
    });
    const policy = definePolicy(permissions, {
      subject: () => null,
      roles: [
        role("reader", [
          allow(permissions.note.read, {
            where: sqlFunction("note_ok", { twin: { status: "open" } }),
          }),
          allow(permissions.note.update, {
            where: opaque({ sql: "true", fingerprint: "fp" }),
          }),
        ]),
      ],
    });
    const { warnings } = compile(policy);
    expect(warnings).toContain(
      "sqlFunction note_ok on reader/note.read is portable via twin",
    );
    expect(warnings).toContain(
      "opaque SQL on reader/note.update is untestable app-side",
    );
  });

  it("copies role rows under former keys and warns once for select coverage", () => {
    const renamed = definePermissions(
      { note: resource({ actions: ["read"] }) },
      { renamed: { "memo.read": "note.read" } },
    );
    const alias = compile(
      definePolicy(renamed, {
        subject: () => null,
        roles: [role("reader", [allow(renamed.note.read)])],
      }),
    );
    expect(
      alias.rolePermissions.some(
        (row) => row.permission === "memo.read" && row.grantKey === "memo.read",
      ),
    ).toBe(true);

    const writes = definePermissions({
      note: resource({ actions: ["update", "delete"] }),
    });
    const covered = compile(
      definePolicy(writes, {
        subject: () => null,
        roles: [
          role("editor", [allow(writes.note.update)]),
          role("owner", [allow(writes.note.delete)]),
        ],
      }),
    );
    expect(
      covered.warnings.filter((warning) =>
        warning.startsWith("added SELECT coverage"),
      ),
    ).toHaveLength(1);
    expect(
      covered.branches.filter((branch) => branch.coverage === true),
    ).toHaveLength(2);
  });

  it("applies one api-key ceiling, two keys, or both ceilings", () => {
    const notes = definePermissions({
      note: resource({ actions: ["read", "update"] }),
    });
    const standIn = compile(
      definePolicy(notes, {
        subject: () => null,
        grants: [
          allow(notes.note.read, {
            to: authenticated(),
            requires: [notes.note.update],
          }),
        ],
      }),
      { apiKeys },
    );
    const standInAccess =
      standIn.branches.find((branch) => branch.permissionKey === "note.read")
        ?.access ?? "";
    expect(standInAccess).toContain("permdock_api_key_allows('note.update')");
    expect(standInAccess).not.toContain("permdock_api_key_allows('note.read')");

    const files = definePermissions({
      folder: resource({ actions: ["read"] }),
      file: resource({
        parent: { field: "folderId", resource: "folder" },
        actions: ["read", "update"],
      }),
    });
    const required = compile(
      definePolicy(files, {
        subject: () => null,
        roles: [
          role(
            "guest",
            [allow(files.file.read, { requires: [files.file.update] })],
            { on: files.folder },
          ),
        ],
      }),
      { apiKeys, memberships: { resource: { folder: folderMembers } } },
    );
    const requiredAccess =
      required.branches.find((branch) => branch.permissionKey === "file.read")
        ?.access ?? "";
    expect(requiredAccess).toContain("permdock_api_key_allows('file.read')");
    expect(requiredAccess).toContain("permdock_api_key_allows('file.update')");
    expect(requiredAccess).toContain(" and ");

    const both = compile(
      definePolicy(notes, {
        subject: () => null,
        grants: [allow(notes.note.read, { to: authenticated() })],
      }),
      { apiKeys, tokenScopes: { scopes: {} } },
    );
    const bothAccess =
      both.branches.find((branch) => branch.permissionKey === "note.read")
        ?.access ?? "";
    expect(bothAccess).toContain("permdock_api_key_allows('note.read')");
    expect(bothAccess).toContain("permdock_token_scope_allows('note.read')");
    expect(bothAccess).toContain(" and ");
  });
});

describe("compileConditionSql uncovered branches", () => {
  const base: RlsSqlContext = {
    dialect: "supabase",
    tenantClaim: "tenant_id",
    scopes: scopeList(undefined),
    gucPrefix: "app",
  };

  it("compiles an invalid date to null and an ISO date to a literal", () => {
    // SAFETY: { date } is a condition value the SQL compiler reads at runtime.
    const invalid: Condition = {
      op: "eq",
      field: "due",
      value: { date: "not-a-date" },
    };
    // SAFETY: { date } is a condition value the SQL compiler reads at runtime.
    const valid: Condition = {
      op: "eq",
      field: "due",
      value: { date: "2020-01-02T00:00:00.000Z" },
    };
    expect(compileConditionSql(invalid, base)).toBe(`"due" = null`);
    expect(compileConditionSql(valid, base)).toBe(
      `"due" = '2020-01-02T00:00:00.000Z'`,
    );
  });

  it("omits a membership disabled check until disabledAt is set", () => {
    const member = {
      op: "memberOf",
      scope: "team",
      field: "team_id",
      roles: ["lead"],
    } as const;
    const table = {
      table: "team_members",
      user: "user_id",
      role: "role",
      columns: { team: "team_id", tenant: "tenant_id" },
    };
    const plain = compileConditionSql(member, {
      ...base,
      memberships: { scopes: { team: table } },
    });
    const suspended = compileConditionSql(member, {
      ...base,
      memberships: { scopes: { team: { ...table, disabledAt: "banned_at" } } },
    });
    expect(plain).not.toContain("banned_at");
    expect(suspended).toContain(`m."banned_at" is null`);
  });

  it("includes candidate ids at depth 0 and leaves them out deeper", () => {
    const related = {
      op: "related",
      resource: "folder",
      relation: "viewer",
      field: "folder_id",
      depth: 0,
      permission: "folder.read",
    } as const;
    const extra = { candidates: "public.candidates" };
    const shallow = compileConditionSql(related, { ...base, ...extra });
    const deep = compileConditionSql(
      { ...related, depth: 1 },
      { ...base, ...extra },
    );
    expect(shallow).toContain("public.candidates");
    expect(shallow).toContain("permitted_folder_rows");
    expect(deep).toContain("permitted_folder_rows");
    expect(deep).not.toContain("public.candidates");
  });

  it("compiles a link hop when closure depths are absent", () => {
    const permissions = definePermissions({
      folder: resource({
        actions: ["read"],
        links: { team: { field: "teamId", resource: "team" } },
      }),
      team: resource({ actions: ["read"] }),
    });
    const defined = definePolicy(permissions, { subject: () => null });
    const hop = {
      op: "related",
      resource: "team",
      relation: "",
      field: "team_id",
      depth: 0,
      permission: "team.read",
      hops: [{ resource: "folder", link: "team" }],
    } as const;
    const graph = { resources: defined.resources };
    // SAFETY: closures is absent so the hop compiler substitutes {}.
    const open = compileConditionSql(hop, {
      ...base,
      graph: graph as NonNullable<RlsSqlContext["graph"]>,
    });
    const closed = compileConditionSql(hop, {
      ...base,
      graph: { ...graph, closures: {} },
    });
    expect(open).toBe(closed);
    expect(open).toContain("permitted_team_rows('team.read')");
  });
});

describe("rls migrate uncovered sql", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const target = {
    schema: "permdock",
    sql: "",
    permissions: new Set<string>(),
    rowConditions: new Set<string>(),
    granted: new Map<string, ReadonlySet<string>>(),
    renamed: {},
    roles: new Set<string>(),
  };

  async function migrated(files: Readonly<Record<string, string>>) {
    const cwd = tempDir("permdock-migrate-");
    const sql = join(cwd, "sql");
    mkdirSync(sql);
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(sql, name), text);
    }
    const result = await runRlsMigrate({
      cwd,
      sql: "sql",
      config: {
        helpers: {
          is_system_user_with: { form: "global" },
          has_org_permission: { form: "row", scope: "organization" },
        },
      },
      target,
      write: false,
      json: true,
    });
    // SAFETY: json output is the MigrateReport runRlsMigrate builds.
    return JSON.parse(result.output) as MigrateReport;
  }

  it("skips an unclosed comment inside a function body and an empty row id", async () => {
    const report = await migrated({
      "comments.sql": `create function public.line_note() returns boolean language sql as $$select public.is_system_user_with('system.organization.read' --x$$;
create function public.block_note() returns boolean language sql as $$select public.is_system_user_with('system.organization.read' /*x$$;
`,
      "empty.sql": `create policy "empty_id" on public.asset for select to authenticated
  using (public.has_org_permission());
`,
      "table.sql": `create table public.notes (id int);
select public.is_system_user_with('system.organization.read');
`,
    });
    const bodies = report.skipped.filter(
      (item) => item.reason === "function-body",
    );
    expect(bodies).toHaveLength(2);
    expect(bodies.every((item) => item.suggestion === undefined)).toBe(true);
    expect(
      report.skipped.some(
        (item) =>
          item.reason === "not-a-column" &&
          item.detail.includes("could not be read"),
      ),
    ).toBe(true);
    expect(report.skipped.some((item) => item.reason === "not-in-policy")).toBe(
      true,
    );
  });
});

describe("scan uncovered sources", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a syntax error, a computed member and an unknown key", () => {
    const cwd = tempDir("permdock-scan-");
    writeFileSync(join(cwd, "broken.ts"), "export const value = {{{");
    writeFileSync(
      join(cwd, "defs.ts"),
      `import { definePermissions, resource } from "permdock";
export const permissions = definePermissions({
  post: resource({ actions: ["read"] }),
});
`,
    );
    writeFileSync(
      join(cwd, "computed.ts"),
      `import { permissions } from "./defs.ts";
export const value = permissions.post[action];
export const wrapped = load().post[action];
export const missing = permissions.post.export;
const [] = [];
for (const [] of [[]]) {}
`,
    );
    const known = new Set(["post.read"]);
    const result = scanSources(
      cwd,
      ["broken.ts", "defs.ts", "computed.ts"].map((file) => join(cwd, file)),
      known,
    );
    expect(result.unparsed.map((item) => item.file)).toContain("broken.ts");
    expect(
      result.unknown.some((item) => item.call.includes("post.export")),
    ).toBe(true);
    expect(result.dynamic.length).toBeGreaterThan(0);
    expect(result.unparsed[0]?.message.length).toBeGreaterThan(0);
  });
});
