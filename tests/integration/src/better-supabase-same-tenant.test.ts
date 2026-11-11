import { PGlite } from "@electric-sql/pglite";
import installed from "better-supabase/package.json" with { type: "json" };
import { moduleBody, sameTenantLayout } from "better-supabase/sql";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A membership that points at a role row, the shape
 * `rls.customRoleWrites.roles` keeps: a tenant's own roles carry
 * `organization_id`, a system role has none.
 */
const SCHEMA = `
create table public.roles (id uuid primary key, organization_id uuid, key text not null);
create table public.organization_memberships (
  organization_id uuid not null,
  user_id uuid not null,
  role_id uuid not null references public.roles,
  primary key (organization_id, user_id)
);
`;

const ID = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACME = ID(100);
const OTHER = ID(200);
const SYSTEM_ROLE = ID(1);
const ACME_ROLE = ID(2);
const OTHER_ROLE = ID(3);

const SEED = `
insert into public.roles values
  ('${SYSTEM_ROLE}', null, 'owner'),
  ('${ACME_ROLE}', '${ACME}', 'acme-editor'),
  ('${OTHER_ROLE}', '${OTHER}', 'other-editor');
`;

const { version } = installed;

/** The memberships block's `same_tenant` function and triggers for `sameTenant`. */
function sameTenantSql(sameTenant: unknown): string {
  const body = moduleBody("memberships", {
    modules: { memberships: { options: { sameTenant } } },
    ...sameTenantLayout([{ text: SCHEMA }], ["public"]),
  });
  if (body === undefined) {
    throw new Error(
      "PermDock test: better-supabase rendered no memberships block",
    );
  }
  const start = body.indexOf(
    "create or replace function better_supabase.same_tenant()",
  );
  const last = body.lastIndexOf(
    "execute function better_supabase.same_tenant(",
  );
  return body.slice(start, body.indexOf(";", last) + 1);
}

describe(`better-supabase ${version} same_tenant on a role with a null tenant`, () => {
  const databases: PGlite[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((db) => db.close()));
  });

  async function database(sameTenant: unknown): Promise<PGlite> {
    const db = new PGlite();
    databases.push(db);
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema better_supabase;
      ${SCHEMA}
      ${sameTenantSql(sameTenant)}
      ${SEED}
    `);
    return db;
  }

  async function assign(
    db: PGlite,
    user: number,
    role: string,
  ): Promise<{ readonly hint?: string; readonly message?: string } | "ok"> {
    try {
      await db.query(
        "insert into public.organization_memberships values ($1, $2, $3)",
        [ACME, ID(user), role],
      );
      return "ok";
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        ...(error !== null &&
        typeof error === "object" &&
        "hint" in error &&
        typeof error.hint === "string"
          ? { hint: error.hint }
          : {}),
      };
    }
  }

  const MISMATCH = {
    hint: "TENANT_MISMATCH",
    message:
      'organization_memberships.role_id must reference a row of "public"."roles" in the same tenant',
  };

  it("refuses a system role by default and another tenant's role always", async () => {
    const db = await database([
      {
        table: "public.organization_memberships",
        column: "role_id",
        references: { table: "public.roles" },
      },
    ]);
    expect(await assign(db, 11, ACME_ROLE)).toBe("ok");
    expect(await assign(db, 12, SYSTEM_ROLE)).toStrictEqual(MISMATCH);
    expect(await assign(db, 13, OTHER_ROLE)).toStrictEqual(MISMATCH);
  });

  it("passes a system role with shared: true and still refuses another tenant's role", async () => {
    const db = await database([
      {
        table: "public.organization_memberships",
        column: "role_id",
        references: { table: "public.roles", shared: true },
      },
    ]);
    expect(await assign(db, 11, ACME_ROLE)).toBe("ok");
    expect(await assign(db, 12, SYSTEM_ROLE)).toBe("ok");
    expect(await assign(db, 13, OTHER_ROLE)).toStrictEqual(MISMATCH);
  });

  it("treats a derived entry over a nullable tenant column as shared from 0.58.1 on", async () => {
    const db = await database({ auto: true });
    // 0.58.0 derived every entry strict; 0.58.1 sets shared when the referenced tenant column may be null.
    expect(await assign(db, 12, SYSTEM_ROLE)).toStrictEqual(
      version === "0.58.0" ? MISMATCH : "ok",
    );
    expect(await assign(db, 13, OTHER_ROLE)).toStrictEqual(MISMATCH);
  });
});
