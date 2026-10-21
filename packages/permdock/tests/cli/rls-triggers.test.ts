import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { runRlsGenerate } from "../../src/cli/rls/generate.ts";
import {
  auditSql,
  generatedTables,
  triggersSql,
} from "../../src/cli/rls/triggers.ts";

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "rls-triggers-"));
writeFileSync(
  path.join(cwd, "policy.ts"),
  `import { allow, definePermissions, definePolicy, resource, role } from 'permdock';

const permissions = definePermissions({
  job: resource({ id: 'id', actions: ['read'], relations: { org: { field: 'orgId', memberOf: 'tenant' } } }),
});

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [role('member', [allow(permissions.job.read)], { on: 'tenant', assignable: true })],
  subject: () => null,
});
`,
);

describe("rls triggers", () => {
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const io = { stdout: () => undefined, stderr: () => undefined };

  function generate(
    rls: NonNullable<PermDockConfig["rls"]>,
    options: { readonly split?: string; readonly out?: string } = {},
  ) {
    return runRlsGenerate({
      cwd,
      config: {
        policy: "./policy.ts",
        rls: {
          authorize: "database",
          customRoles: true,
          memberships: {
            tenant: {
              table: "organization_members",
              tenant: "organization_id",
              user: "user_id",
              role: "role",
            },
          },
          ...rls,
        },
      },
      target: "sql",
      dialect: "supabase",
      rbac: false,
      check: false,
      skipClosures: false,
      inlineFunctions: false,
      io,
      ...(options.split === undefined
        ? { write: false }
        : {
            split: options.split,
            out: options.out ?? "",
            schemas: "migrations" as const,
          }),
    });
  }

  const audit = {
    function: "better_supabase.audit",
    args: { tenant_column: "tenant_id", label_column: "role" },
  };

  describe(generatedTables, () => {
    it("lists the tables the SQL creates in the helper schema", () => {
      expect(
        generatedTables(
          `create table if not exists "permdock".role_permissions (\ncreate table if not exists "public".posts (\ncreate table if not exists "permdock"."user_roles" (`,
          "permdock",
        ),
      ).toStrictEqual(["role_permissions", "user_roles"]);
    });
  });

  describe(triggersSql, () => {
    const tables = ["custom_role_permissions", "role_permissions"];

    it("drops and creates each trigger after the tables", () => {
      expect(
        triggersSql(
          {
            custom_role_permissions: [
              {
                name: "audit_grants",
                when: "after",
                events: ["insert", "update", "delete"],
                function: "audit.log_change",
                args: ["custom_role", "it's"],
              },
            ],
            role_permissions: [
              {
                name: "seed_audit",
                when: "after",
                events: ["truncate"],
                level: "statement",
                function: "audit.log_truncate",
              },
            ],
          },
          "permdock",
          tables,
        ),
      ).toBe(`-- rls.triggers: triggers the application owns on generated tables
drop trigger if exists "audit_grants" on "permdock"."custom_role_permissions";
create trigger "audit_grants"
  after insert or update or delete on "permdock"."custom_role_permissions"
  for each row execute function "audit"."log_change"('custom_role', 'it''s');
drop trigger if exists "seed_audit" on "permdock"."role_permissions";
create trigger "seed_audit"
  after truncate on "permdock"."role_permissions"
  for each statement execute function "audit"."log_truncate"();
`);
    });

    it("refuses an unknown table, a reserved name, an unqualified function and a row-level truncate", () => {
      const trigger = {
        name: "audit_grants",
        when: "after" as const,
        events: ["insert" as const],
        function: "audit.log_change",
      };
      expect(() =>
        triggersSql({ posts: [trigger] }, "permdock", tables),
      ).toThrow(
        "rls.triggers.posts names posts, which rls generate does not create with this config; it creates custom_role_permissions, role_permissions",
      );
      expect(() =>
        triggersSql(
          { role_permissions: [{ ...trigger, name: "permdock_audit" }] },
          "permdock",
          tables,
        ),
      ).toThrow(/outside permdock_/u);
      expect(() =>
        triggersSql(
          { role_permissions: [{ ...trigger, function: "log_change" }] },
          "permdock",
          tables,
        ),
      ).toThrow(/schema-qualified function/u);
      expect(() =>
        triggersSql(
          { role_permissions: [{ ...trigger, events: ["truncate"] }] },
          "permdock",
          tables,
        ),
      ).toThrow(/level: 'statement'/u);
      expect(() =>
        triggersSql(
          { role_permissions: [{ ...trigger, events: [] }] },
          "permdock",
          tables,
        ),
      ).toThrow(/events must list/u);
    });

    it("writes nothing without rls.triggers", () => {
      expect(triggersSql(undefined, "permdock", tables)).toBe("");
    });
  });

  describe(auditSql, () => {
    it("registers the custom-role tables and user_roles that exist by default", () => {
      expect(
        auditSql(audit, "permdock", [
          "custom_role_includes",
          "custom_role_permissions",
          "role_permissions",
        ]),
      )
        .toBe(`-- rls.audit: generated tables registered with better_supabase.audit
select "better_supabase"."audit"('"permdock"."custom_role_permissions"'::regclass, "tenant_column" => 'tenant_id', "label_column" => 'role');
select "better_supabase"."audit"('"permdock"."custom_role_includes"'::regclass, "tenant_column" => 'tenant_id', "label_column" => 'role');
`);
    });

    it("checks listed tables and argument names", () => {
      expect(() =>
        auditSql({ ...audit, tables: ["posts"] }, "permdock", ["user_roles"]),
      ).toThrow(/rls.audit.tables names posts/u);
      expect(() =>
        auditSql({ function: "a.b", args: { "x; drop": "y" } }, "permdock", [
          "user_roles",
        ]),
      ).toThrow(/not a lower-case parameter name/u);
    });
  });

  describe("rls generate with rls.triggers and rls.audit", () => {
    it("puts the triggers and the audit calls after the tables in one file", async () => {
      const outcome = await generate({
        triggers: {
          custom_role_permissions: [
            {
              name: "audit_grants",
              when: "after",
              events: ["insert", "delete"],
              function: "audit.log_change",
            },
          ],
        },
        audit,
      });
      expect(outcome.code).toBe(0);
      const text = outcome.text;
      expect(text).toContain(
        'alter table "permdock".custom_role_permissions add column if not exists id bigint generated always as identity primary key;',
      );
      const table = text.indexOf(
        'create table if not exists "permdock".custom_role_permissions',
      );
      const trigger = text.indexOf('create trigger "audit_grants"');
      const call = text.indexOf('select "better_supabase"."audit"');
      expect(table).toBeGreaterThan(-1);
      expect(trigger).toBeGreaterThan(table);
      expect(call).toBeGreaterThan(trigger);
      expect(text).toContain(
        `select "better_supabase"."audit"('"permdock"."user_roles"'::regclass`,
      );
    });

    it("exits 2 for a table the run does not create", async () => {
      const outcome = await generate({
        customRoles: false,
        triggers: {
          custom_role_permissions: [
            {
              name: "audit_grants",
              when: "after",
              events: ["insert"],
              function: "audit.log_change",
            },
          ],
        },
      });
      expect(outcome.code).toBe(2);
      expect(outcome.output).toContain(
        "rls.triggers.custom_role_permissions names custom_role_permissions, which rls generate does not create",
      );
    });

    it("keeps the triggers in the helpers part and moves the audit calls to the seeds part", async () => {
      const out = "supabase/schemas/056_permdock_{part}.sql";
      const outcome = await generate(
        {
          triggers: {
            custom_role_includes: [
              {
                name: "audit_includes",
                when: "after",
                events: ["insert"],
                function: "audit.log_change",
              },
            ],
          },
          audit,
        },
        { split: "helpers,seeds", out },
      );
      expect(outcome.code).toBe(0);
      const helpers = readFileSync(
        path.join(cwd, "supabase/schemas/056_permdock_helpers.sql"),
        "utf8",
      );
      const seeds = readFileSync(
        path.join(cwd, "supabase/schemas/056_permdock_seeds.sql"),
        "utf8",
      );
      expect(helpers).toContain('create trigger "audit_includes"');
      expect(helpers).not.toContain("better_supabase");
      expect(seeds).toContain('select "better_supabase"."audit"');
    });
  });

  describe("rls.triggers and rls.audit edge cases", () => {
    const tables = ["custom_role_includes", "custom_role_permissions"];
    const base = {
      name: "t",
      when: "after",
      events: ["insert"],
      function: "app.f",
    } as const;

    it("refuses an unknown when or level", () => {
      expect(() =>
        triggersSql(
          // SAFETY: a config file is untyped JavaScript; this is what one may pass.
          { custom_role_permissions: [{ ...base, when: "during" } as never] },
          "permdock",
          tables,
        ),
      ).toThrow(/when must be before or after/u);
      expect(() =>
        triggersSql(
          // SAFETY: as above, a level the type does not allow.
          { custom_role_permissions: [{ ...base, level: "column" } as never] },
          "permdock",
          tables,
        ),
      ).toThrow(/level must be row or statement/u);
    });

    it("orders tables by name and writes nothing for empty lists", () => {
      expect(
        triggersSql(
          { custom_role_permissions: [], custom_role_includes: [] },
          "permdock",
          tables,
        ),
      ).toBe("");
      const sql = triggersSql(
        { custom_role_permissions: [base], custom_role_includes: [base] },
        "permdock",
        tables,
      );
      expect(sql.indexOf("custom_role_includes")).toBeLessThan(
        sql.indexOf("custom_role_permissions"),
      );
    });

    it("calls the audit function without arguments, and not at all with no table", () => {
      expect(auditSql({ function: "audit.track" }, "permdock", tables)).toBe(
        `-- rls.audit: generated tables registered with audit.track
select "audit"."track"('"permdock"."custom_role_permissions"'::regclass);
select "audit"."track"('"permdock"."custom_role_includes"'::regclass);
`,
      );
      expect(auditSql({ function: "audit.track" }, "permdock", [])).toBe("");
    });
  });
});
