import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type {
  MigrateReport,
  MigrateTarget,
} from "../../src/cli/rls/migrate.ts";
import type { RlsMigrateConfig } from "../../src/cli/types.ts";

import {
  mapKey,
  migrateTarget,
  runRlsMigrate,
} from "../../src/cli/rls/migrate.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(path.join(TMP, "rls-migrate-cases-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const CONFIG: RlsMigrateConfig = {
  helpers: {
    org_ids: { form: "ids", scope: "org" },
    team_ids: { form: "ids", scope: "team" },
    has_org: { form: "row", scope: "org" },
    authorize: { form: "scoped" },
    is_admin: { form: "global" },
    is_member: { form: "membership", scope: "org" },
    is_team_member: { form: "membership", scope: "team" },
  },
  scopes: { organization: "org" },
};

function target(overrides: Partial<MigrateTarget> = {}): MigrateTarget {
  return {
    schema: "public",
    sql: [
      'create or replace function "public".permitted_org_ids(',
      'create or replace function "public".permdock_has(',
      'create or replace function "public".member_org_ids(',
    ].join("\n"),
    permissions: new Set(["doc.read", "doc.update", "doc.secret", "doc.audit"]),
    rowConditions: new Set(["doc.secret"]),
    granted: new Map([
      ["org", new Set(["doc.read", "doc.update"])],
      ["global", new Set(["doc.read"])],
    ]),
    renamed: {},
    roles: new Set(["owner", "member"]),
    ...overrides,
  };
}

let counter = 0;
async function migrate(
  sql: string,
  options: {
    readonly target?: MigrateTarget;
    readonly config?: RlsMigrateConfig;
    readonly write?: boolean;
  } = {},
): Promise<{
  readonly code: number;
  readonly report: MigrateReport;
  readonly text: string;
}> {
  counter += 1;
  const cwd = path.join(root, String(counter));
  mkdirSync(cwd, { recursive: true });
  const file = path.join(cwd, "policies.sql");
  writeFileSync(file, sql);
  const result = await runRlsMigrate({
    cwd,
    sql: "policies.sql",
    config: options.config ?? CONFIG,
    target: options.target ?? target(),
    write: options.write ?? true,
    json: true,
  });
  // SAFETY: json: true prints the MigrateReport.
  const report = JSON.parse(result.output) as MigrateReport;
  return { code: result.code, report, text: readFileSync(file, "utf8") };
}

function reasons(
  report: MigrateReport,
): readonly (readonly [string, string])[] {
  return report.skipped.map((item) => [item.reason, item.detail] as const);
}

describe("migrateTarget", () => {
  it("defaults the schema and keys of an outcome without them", () => {
    expect(migrateTarget({ code: 0, output: "", text: "sql" })).toStrictEqual({
      schema: "permdock",
      sql: "sql",
      permissions: new Set(),
      rowConditions: new Set(),
      granted: new Map(),
      renamed: {},
      roles: new Set(),
    });
  });
});

describe("an id that is an expression", () => {
  it.each([
    [
      "a cast of an indirection",
      `create policy p on storage.objects using (has_org((storage.foldername(name))[1]::uuid, 'doc.read'));`,
      `create policy p on storage.objects using ((((storage.foldername(name))[1]::uuid) in (select public.permitted_org_ids('doc.read'))));`,
    ],
    [
      "a function call with commas",
      `create policy p on t using (is_member(coalesce(org_id, other_id)));`,
      `create policy p on t using (((coalesce(org_id, other_id)) in (select public.member_org_ids())));`,
    ],
    [
      "a scoped id",
      `create policy p on t using (authorize('organization', lower(org_id), 'doc.read'));`,
      `create policy p on t using (((lower(org_id)) in (select public.permitted_org_ids('doc.read'))));`,
    ],
  ])("is copied into the rewrite: %s", async (_label, sql, expected) => {
    const { report, text } = await migrate(sql);
    expect(report.skipped).toStrictEqual([]);
    expect(text).toBe(expected);
  });
});

describe("a call inside a function body", () => {
  it("is skipped with the call it would become", async () => {
    const { report } = await migrate(
      `create function f() returns boolean language sql as $$ select is_member(org_id) $$;`,
    );
    expect(report.skipped).toStrictEqual([
      expect.objectContaining({
        reason: "function-body",
        suggestion: "(org_id in (select public.member_org_ids()))",
      }),
    ]);
  });

  it("reads quoted and bracketed arguments to build the suggestion", async () => {
    const { report } = await migrate(
      `create function f() returns boolean language sql as $$ select authorize('organization', (ids)[1], 'doc.read') $$;`,
    );
    expect(report.skipped[0]?.suggestion).toBe(
      "(((ids)[1]) in (select public.permitted_org_ids('doc.read')))",
    );
    const quoted = await migrate(
      `create function f() returns boolean language sql as $$ select is_member(coalesce(org_id, 'a,b)')) $$;`,
    );
    expect(quoted.report.skipped[0]?.suggestion).toBe(
      "((coalesce(org_id, 'a,b)')) in (select public.member_org_ids()))",
    );
  });

  it("has no suggestion when the call cannot be delimited", async () => {
    const { report } = await migrate(
      `create function f() returns boolean language sql as $$ select is_admin(E'\\'') $$;`,
    );
    expect(report.skipped[0]?.suggestion).toBeUndefined();
  });

  it("has no suggestion when the call cannot be rewritten", async () => {
    const { report } = await migrate(
      `create function f() returns boolean language sql as $$ select is_admin('doc.audit') $$;`,
    );
    expect(report.skipped[0]?.suggestion).toBeUndefined();
  });
});

describe("mapKey without prefixes", () => {
  it("keeps an unmapped key", () => {
    expect(mapKey({ helpers: {} }, "doc.read")).toBe("doc.read");
  });

  it("applies keys, then renamed, then prefixes", () => {
    const renamed = { "legacy.read": "doc.read" };
    expect(mapKey({ helpers: {} }, "legacy.read", renamed)).toBe("doc.read");
    expect(
      mapKey(
        { helpers: {}, keys: { "legacy.read": "doc.update" } },
        "legacy.read",
        renamed,
      ),
    ).toBe("doc.update");
    expect(
      mapKey(
        { helpers: {}, prefixes: { "legacy.": "doc." } },
        "legacy.update",
        renamed,
      ),
    ).toBe("doc.update");
  });

  it("rewrites a former key to the current one", async () => {
    const { code, text } = await migrate(
      `create policy p on t using (org_id in (select org_ids('doc.view')));`,
      {
        config: { ...CONFIG, keys: {}, prefixes: {} },
        target: target({ renamed: { "doc.view": "doc.read" } }),
      },
    );
    expect(code).toBe(0);
    expect(text).toContain(`permitted_org_ids('doc.read')`);
  });
});

describe("runRlsMigrate skips", () => {
  it.each([
    [
      "a missing ids helper",
      `create policy p on t using (team_id in (select team_ids('doc.read')));`,
      [
        "missing-helper",
        "rls generate writes no permitted_team_ids for this policy",
      ],
    ],
    [
      "a missing membership helper",
      `create policy p on t using (is_team_member(team_id));`,
      [
        "missing-helper",
        "rls generate writes no member_team_ids: team has no membership source",
      ],
    ],
    [
      "a scope that is not a literal",
      `create policy p on t using (authorize(scope_col, org_id, 'doc.read'));`,
      [
        "unknown-scope",
        "the scope is not a string literal; rewrite it by hand",
      ],
    ],
    [
      "a global key that is not granted anywhere",
      `create policy p on t using (is_admin('doc.audit'));`,
      [
        "not-granted-on-scope",
        "doc.audit has no unconditional allow row in role_permissions: a conditional, time-bounded or deny-mixed grant splits its grant key, so the helper would always deny",
      ],
    ],
    [
      "a call it cannot delimit",
      `create policy p on t using (is_admin(E'\\''));`,
      ["not-a-column", "the call could not be delimited"],
    ],
  ])("skips %s", async (_label, sql, expected) => {
    const { report, text } = await migrate(sql);
    expect(report.rewrites).toStrictEqual([]);
    expect(reasons(report)).toStrictEqual([expected]);
    expect(text).toBe(sql);
  });

  it("skips the global form when permdock_has is not generated", async () => {
    const { report } = await migrate(
      `create policy p on t using (is_admin('doc.read'));`,
      { target: target({ sql: "" }) },
    );
    expect(reasons(report)).toStrictEqual([
      ["missing-helper", "rls generate writes no permdock_has"],
    ]);
  });

  it("reports a file that does not parse, but only when it names a helper", async () => {
    const broken = await migrate(
      `create policy p on t using (is_admin('doc.read');`,
    );
    expect(broken.report.skipped).toMatchObject([
      { line: 1, call: "", reason: "unparsed" },
    ]);
    expect(broken.report.skipped[0]?.detail).toMatch(
      /^the file does not parse: /u,
    );
    const unrelated = await migrate("not sql at all (");
    expect(unrelated.report).toStrictEqual({ rewrites: [], skipped: [] });
  });

  it("reports calls in function bodies whose text is escaped", async () => {
    const sql = `create function f() returns boolean language sql as 'select is_admin(''doc.read'')';
do $$ begin perform org_ids('doc.read'); end $$;`;
    const { report } = await migrate(sql);
    expect(
      report.skipped.map((item) => [item.line, item.reason, item.call]),
    ).toStrictEqual([
      [1, "function-body", "is_admin"],
      [2, "function-body", "org_ids"],
    ]);
  });
});

describe("runRlsMigrate role helpers", () => {
  const roleConfig: RlsMigrateConfig = {
    helpers: { has_org_role: { form: "role", scope: "org" } },
  };
  const withRoles = (overrides: Partial<MigrateTarget> = {}) =>
    target({
      sql: [
        'create or replace function "public".member_org_ids(',
        'create or replace function "public".member_org_ids(p_roles text[])',
      ].join("\n"),
      roleValues: { org_admin: "owner" },
      ...overrides,
    });

  it("filters the member helper by the mapped roles", async () => {
    const { code, report, text } = await migrate(
      `create policy p on t using (has_org_role(org_id, 'org_admin', 'member'));`,
      { config: roleConfig, target: withRoles() },
    );
    expect({ code, text }).toStrictEqual({
      code: 0,
      text: `create policy p on t using ((org_id in (select public.member_org_ids(array['owner', 'member']))));`,
    });
    expect(report.skipped).toStrictEqual([]);
  });

  it.each([
    [
      "a role that is not a literal",
      `create policy p on t using (has_org_role(org_id, role_col));`,
      withRoles(),
      ["dynamic-role", "a role is not a string literal; map it by hand"],
    ],
    [
      "a role no grant names",
      `create policy p on t using (has_org_role(org_id, 'auditor'));`,
      withRoles(),
      [
        "unknown-role",
        "auditor maps to auditor, which no role grants; add it to rls.roleValues or declare the role",
      ],
    ],
    [
      "a policy without the role-filtered helper",
      `create policy p on t using (has_org_role(org_id, 'member'));`,
      target(),
      [
        "missing-helper",
        "rls generate writes no member_org_ids(p_roles text[]): run it with this rls.migrate config, which asks for it",
      ],
    ],
  ])("skips %s", async (_label, sql, roleTarget, expected) => {
    const { report } = await migrate(sql, {
      config: roleConfig,
      target: roleTarget,
    });
    expect(reasons(report)).toStrictEqual([expected]);
  });
});

describe("runRlsMigrate rewrites", () => {
  it("maps scopes, quotes an unsafe schema and keeps comments and strings inside calls", async () => {
    const quoted = target({
      schema: "App",
      sql: [
        'create or replace function "App".permitted_org_ids(',
        'create or replace function "App".permdock_has(',
      ].join("\n"),
    });
    const sql = `-- é and 😀 shift byte offsets
create policy p on t using (
  has_org(org_id, /* ) */ 'doc.read' -- )
  )
  or authorize('organization', org_id, 'doc.update')
  or authorize('global', null, 'doc.read')
);`;
    const { code, report, text } = await migrate(sql, { target: quoted });
    expect(code).toBe(0);
    expect(report.rewrites.map((item) => [item.line, item.to])).toStrictEqual([
      [3, `(org_id in (select "App".permitted_org_ids('doc.read')))`],
      [5, `(org_id in (select "App".permitted_org_ids('doc.update')))`],
      [6, `(select "App".permdock_has('doc.read'))`],
    ]);
    expect(text).toBe(`-- é and 😀 shift byte offsets
create policy p on t using (
  (org_id in (select "App".permitted_org_ids('doc.read')))
  or (org_id in (select "App".permitted_org_ids('doc.update')))
  or (select "App".permdock_has('doc.read'))
);`);
  });

  it("leaves files alone on a dry run and reads a single file path", async () => {
    const sql = `create policy p on t using (is_member(org_id));`;
    const { report, text } = await migrate(sql, { write: false });
    expect(report.rewrites).toStrictEqual([
      {
        file: "policies.sql",
        line: 1,
        from: "is_member(org_id)",
        to: "(org_id in (select public.member_org_ids()))",
      },
    ]);
    expect(text).toBe(sql);
  });

  it("prints a summary naming unknown keys", async () => {
    const cwd = path.join(root, "summary");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      path.join(cwd, "a.sql"),
      `create policy p on t using (is_admin('doc.nope') or is_admin('doc.read'));`,
    );
    const result = await runRlsMigrate({
      cwd,
      sql: "a.sql",
      config: CONFIG,
      target: target(),
      write: true,
      json: false,
    });
    expect(result.code).toBe(1);
    expect(result.output.split("\n")).toStrictEqual([
      "a.sql:1  is_admin('doc.read')  ->  (select public.permdock_has('doc.read'))",
      "skipped a.sql:1  is_admin('doc.nope'): doc.nope maps to doc.nope, which the policy does not declare; add it to rls.migrate.keys or the vocabulary",
      "rls migrate: rewrote 1 call(s) in 1 file(s), skipped 1, 1 with an unknown key",
    ]);
  });

  it("answers 2 for a missing --sql path", async () => {
    expect(
      await runRlsMigrate({
        cwd: root,
        sql: "nowhere",
        config: CONFIG,
        target: target(),
        write: false,
        json: false,
      }),
    ).toStrictEqual({
      code: 2,
      output: "rls migrate --sql: nowhere does not exist",
    });
  });
});
