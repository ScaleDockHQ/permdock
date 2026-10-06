import { describe, expect, it } from "vitest";

import type { CompiledPolicy } from "../../src/cli/rls-compile.ts";

import {
  defaultOut,
  dialectRoles,
  emitDrizzle,
  emitPrisma,
  emitSql,
  migrationOut,
  migrationSql,
} from "../../src/cli/rls-emit.ts";

function policy(over: Partial<CompiledPolicy> = {}): CompiledPolicy {
  return {
    name: "doc_read",
    table: "doc",
    command: "select",
    effect: "allow",
    roles: ["authenticated"],
    ...over,
  };
}

describe("the service_role guard", () => {
  it.each([
    ["emitSql", () => emitSql([policy({ roles: ["service_role"] })], "")],
    [
      "migrationSql",
      () => migrationSql([], "grant all on t to service_role;", false, []),
    ],
    [
      "emitDrizzle",
      () =>
        emitDrizzle([policy({ using: "x to service_role\n" })], {
          dialect: "guc",
        }),
    ],
    [
      "emitPrisma",
      () => emitPrisma([policy({ using: "grant to service_role" })]),
    ],
    [
      "emitPrisma roles",
      () => emitPrisma([policy({ using: "roles = [service_role]" })]),
    ],
  ])("refuses service_role from %s", (_name, emit) => {
    expect(emit).toThrow("generated RLS must never emit service_role");
  });
});

describe("emitSql and migrationSql", () => {
  it("writes nothing to migrate without a preamble, tables or views", () => {
    expect(migrationSql([], "  ", false, [])).toBe("");
  });

  it("forces RLS and writes check-only and restrictive policies", () => {
    const text = emitSql(
      [
        policy({ command: "insert", check: "ok()" }),
        policy({
          name: "deny_doc",
          effect: "deny",
          roles: ["anon", "authenticated"],
        }),
      ],
      "",
      true,
    );
    expect(text).toContain(
      'alter table "public"."doc" enable row level security;\nalter table "public"."doc" force row level security;\nrevoke all on table "public"."doc"',
    );
    expect(text).toContain(
      'grant insert on table "public"."doc" to authenticated;',
    );
    expect(text).toContain("  with check (ok())");
    expect(text).toContain("  as restrictive");
  });

  it("renames only role lists for neon", () => {
    expect(
      dialectRoles(
        "grant select on t to anon, authenticated;\nanon stays",
        "neon",
      ),
    ).toBe("grant select on t to anonymous, authenticated;\nanon stays");
    expect(dialectRoles("to anon;", "supabase")).toBe("to anon;");
  });
});

describe("emitDrizzle", () => {
  it("declares roles for guc and neon and escapes quotes and template text", () => {
    const anon = policy({
      roles: ["anon", "authenticated"],
      using: "a = `b` and c = ${d}",
    });
    const guc = emitDrizzle(
      [anon, policy({ name: "doc_deny", effect: "deny" })],
      {
        dialect: "guc",
        schema: String.raw`./it's\db`,
        helpers: "rls.migration.sql",
      },
    );
    expect(guc).toContain("export const anonRole = pgRole('anon').existing()");
    expect(guc).toContain(String.raw`import * as schema from './it\'s\\db'`);
    expect(guc).toContain("// run rls.migration.sql in a custom migration");
    expect(guc).toContain(
      String.raw`using: sql` + "`a = \\`b\\` and c = \\${d}`",
    );
    expect(guc).toContain("as: 'restrictive'");
    expect(emitDrizzle([anon], { dialect: "neon" })).toContain(
      "export const anonRole = pgRole('anonymous').existing()",
    );
  });

  it("imports only the Supabase roles it uses", () => {
    const text = emitDrizzle(
      [policy({ check: "(select auth.uid()) = owner" })],
      {
        dialect: "supabase",
      },
    );
    expect(text).toContain(
      "import { authenticatedRole, authUid } from 'drizzle-orm/supabase'",
    );
    expect(text).toContain("withCheck: sql`${authUid} = owner`");
  });

  it("names a schema-qualified table's export after the table alone", () => {
    const text = emitDrizzle(
      [policy({ name: "app_web_hooks_select", table: "app.web_hooks" })],
      { dialect: "guc" },
    );
    expect(text).toContain("export const appWebHooksSelect = pgPolicy(");
    expect(text).toContain("}).link(schema.webHooks)");
  });

  it("refuses a table export that is not an identifier", () => {
    expect(() =>
      emitDrizzle([policy()], { dialect: "guc", exports: { doc: "my-docs" } }),
    ).toThrow('table export "my-docs" is not an identifier');
  });
});

describe("emitPrisma", () => {
  it("lists every target model and writes withCheck", () => {
    const text = emitPrisma(
      [
        policy(),
        policy({
          name: "note_write",
          table: "team_note",
          command: "insert",
          check: "ok()",
        }),
      ],
      { models: { doc: "Document" }, helpers: "m.sql" },
    );
    expect(text).toContain("// add @@rls to models Document, TeamNote;");
    expect(text).toContain("// run m.sql in a migration before these policies");
    expect(text).toContain('  withCheck = "ok()"');
  });

  it("names a schema-qualified table's model after the table alone", () => {
    const text = emitPrisma([policy({ table: "app.team_note" })]);
    expect(text).toContain("// add @@rls to model TeamNote;");
  });

  it("needs --target sql for a deny", () => {
    expect(() => emitPrisma([policy({ effect: "deny" })])).toThrow(
      "Prisma policy blocks are permissive only, so doc_read (a deny) needs --target sql",
    );
  });
});

describe("output paths", () => {
  it("places the migration next to out and defaults out per target", () => {
    expect(migrationOut("db/policies.ts")).toBe("db/policies.migration.sql");
    expect(migrationOut("db.v2/policies")).toBe("db.v2/policies.migration.sql");
    expect([
      defaultOut("sql"),
      defaultOut("drizzle"),
      defaultOut("prisma"),
    ]).toEqual(["rls.sql", "src/db/policies.ts", "prisma/policies.prisma"]);
  });
});
