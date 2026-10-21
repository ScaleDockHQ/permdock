import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { DatabaseError } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/custom-role-writes");
const REQUIRES_FIXTURE = join(HERE, "../fixtures/custom-role-writes-requires");
const BY_ID_FIXTURE = join(HERE, "../fixtures/custom-role-by-id");

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const MANAGER = "00000000-0000-4000-8000-0000000000b2";
const STEWARD = "00000000-0000-4000-8000-0000000000c3";
const OPERATOR = "00000000-0000-4000-8000-0000000000d4";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${ADMIN}'), ('${MANAGER}'), ('${STEWARD}'), ('${OPERATOR}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MANAGER}', 'manager'),
  ('acme', '${STEWARD}', 'steward');
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
`;

describe("permdock_replace_custom_role_grants with levels, renamed keys and manageRoles", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-custom-role-writes-"));

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const outcome = async (work: () => Promise<unknown>): Promise<string> => {
    try {
      await work();
      return "ok";
    } catch (error) {
      return error instanceof DatabaseError
        ? `${error.code ?? ""} ${error.hint ?? ""}`.trim()
        : String(error);
    }
  };

  const call = (
    sub: string,
    sql: string,
    values: readonly unknown[],
  ): Promise<string> =>
    outcome(async () => {
      if (db === undefined) {
        throw new Error("PermDock: Postgres was not started");
      }
      await db.as(
        {
          role: "authenticated",
          settings: {
            "request.jwt.claims": JSON.stringify({
              sub,
              role: "authenticated",
            }),
          },
        },
        async () => {
          await db?.tester.query(sql, [...values]);
        },
      );
    });

  const acme = { tenant: "acme", scope: "tenant" } as const;
  const platform = { tenant: null, scope: "global" } as const;

  const save = (
    sub: string,
    role: string,
    allow: readonly string[],
    at: { readonly tenant: string | null; readonly scope: string } = acme,
  ): Promise<string> =>
    call(
      sub,
      "select permdock.permdock_replace_custom_role_grants($1, $2, null, $3, $4, '{}', '{}')",
      [at.tenant, at.scope, role, [...allow]],
    );

  /**
   * Runs `sql` as the table owner, the way a migration or a job does, and rolls
   * back.
   */
  const asOwner = (sql: string, values: readonly unknown[]): Promise<string> =>
    outcome(async () => {
      if (db === undefined) {
        throw new Error("PermDock: Postgres was not started");
      }
      await db.admin.query("begin");
      try {
        await db.admin.query(sql, [...values]);
      } finally {
        await db.admin.query("rollback");
      }
    });

  it("hands out only the levels the caller's own grants reach", async () => {
    expect(await save(MANAGER, "self-service", ["job.update@own"])).toBe("ok");
    expect(await save(MANAGER, "wide", ["job.update@all"])).toBe(
      "42501 not-assignable-by",
    );
    expect(await save(MANAGER, "wide", ["job.update"])).toBe(
      "42501 not-assignable-by",
    );
    expect(await save(MANAGER, "reader", ["job.read"])).toBe("ok");
    expect(await save(ADMIN, "wide", ["job.update"])).toBe("ok");
  });

  it("refuses a level the resource does not declare", async () => {
    expect(await save(ADMIN, "odd", ["job.read@team"])).toBe(
      "22023 unknown-level",
    );
  });

  it("lifts the hand-out check for a manageRoles holder, never the ceiling", async () => {
    expect(await save(STEWARD, "wide", ["job.update@all"])).toBe("ok");
    expect(await save(STEWARD, "wide", ["member.assignRole"])).toBe(
      "22023 outside-ceiling",
    );
  });

  it("stores an entry under a renamed key as the current key", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query("begin");
    try {
      await db.admin.query("set local role authenticated");
      await db.admin.query(
        `select set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: ADMIN, role: "authenticated" })],
      );
      await db.admin.query(
        "select permdock.permdock_replace_custom_role_grants('acme', 'tenant', null, 'legacy', array['task.read'], array['task.read'], '{}')",
      );
      await db.admin.query("reset role");
      const rows = await db.admin.query<{ entry: string }>(
        "select effect || ':' || permission as entry from permdock.custom_role_permissions where role = 'legacy' order by 1",
      );
      expect(rows.rows.map((row) => row.entry)).toStrictEqual([
        "allow:job.read",
        "deny:job.read",
      ]);
    } finally {
      await db.admin.query("rollback");
    }
  });

  it("lets a manageRoles holder through a global role write any tenant without a membership", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query(
      `insert into permdock.user_roles (user_id, role) values ('${OPERATOR}', 'operator') on conflict do nothing`,
    );
    expect(await save(OPERATOR, "night-shift", ["job.update@all"])).toBe("ok");
    expect(await save(OPERATOR, "night-shift", ["member.assignRole"])).toBe(
      "22023 outside-ceiling",
    );
  });

  it("saves a platform custom role only for a global manageRoles holder, inside the global ceiling", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query(
      `insert into permdock.user_roles (user_id, role) values ('${OPERATOR}', 'operator') on conflict do nothing`,
    );
    expect(await save(OPERATOR, "auditor", ["job.read"], platform)).toBe("ok");
    expect(await save(OPERATOR, "auditor", ["job.update"], platform)).toBe(
      "22023 outside-ceiling",
    );
    expect(await save(ADMIN, "auditor", ["job.read"], platform)).toBe(
      "42501 not-member",
    );
    expect(await save(STEWARD, "auditor", ["job.read"], platform)).toBe(
      "42501 not-member",
    );
    expect(
      await save(OPERATOR, "auditor", ["job.read"], {
        tenant: "acme",
        scope: "global",
      }),
    ).toBe("22023 unknown-scope");
  });

  it("saves a shared custom role only for a global manageRoles holder, and refuses its name to a tenant", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query(
      `insert into permdock.user_roles (user_id, role) values ('${OPERATOR}', 'operator') on conflict do nothing`,
    );
    const shared = { tenant: null, scope: "tenant" } as const;
    expect(await save(ADMIN, "dispatch", ["job.read"], shared)).toBe(
      "42501 not-member",
    );
    expect(await save(STEWARD, "dispatch", ["job.read"], shared)).toBe(
      "42501 not-member",
    );
    expect(await save(OPERATOR, "dispatch", ["job.update@all"], shared)).toBe(
      "ok",
    );
    expect(
      await call(
        OPERATOR,
        "select permdock.permdock_replace_custom_role_grants(null, 'tenant', 'j1', 'dispatch', array['job.read'], '{}', '{}')",
        [],
      ),
    ).toBe("22023 unknown-scope");
    await db.admin.query(
      "insert into permdock.custom_role_permissions (tenant_id, scope, role, permission) values (null, 'tenant', 'dispatch', 'job.read')",
    );
    try {
      expect(await save(ADMIN, "dispatch", ["job.read"])).toBe(
        "22023 name-taken",
      );
      expect(
        await call(
          ADMIN,
          "select permdock.permdock_rename_custom_role_grants('acme', 'tenant', null, 'reader', 'dispatch')",
          [],
        ),
      ).toBe("22023 name-taken");
    } finally {
      await db.admin.query(
        "delete from permdock.custom_role_permissions where role = 'dispatch'",
      );
    }
  });

  it("keeps the trusted functions to the owner and checks the definition there", async () => {
    const trusted =
      "select permdock.permdock_trusted_replace_custom_role_grants($1, $2, null, $3, $4, '{}', '{}')";
    expect(
      await call(ADMIN, trusted, ["acme", "tenant", "seeded", ["job.read"]]),
    ).toBe("42501");
    expect(
      await asOwner(trusted, ["acme", "tenant", "seeded", ["job.update@all"]]),
    ).toBe("ok");
    expect(
      await asOwner(trusted, [
        "acme",
        "tenant",
        "seeded",
        ["member.assignRole"],
      ]),
    ).toBe("22023 outside-ceiling");
    expect(
      await asOwner(trusted, [null, "global", "auditor", ["job.read"]]),
    ).toBe("ok");
    expect(
      await asOwner(trusted, ["acme", "tenant", "admin", ["job.read"]]),
    ).toBe("22023 declared-role");
    expect(
      await asOwner(
        "select permdock.permdock_trusted_delete_custom_role_grants('acme', 'tenant', null, 'seeded')",
        [],
      ),
    ).toBe("ok");
  });
});

describe("rls.customRoleWrites.requires", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-custom-role-requires-"));

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: REQUIRES_FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([
      SETUP,
      readFileSync(out, "utf8"),
      `insert into permdock.user_roles (user_id, role) values ('${OPERATOR}', 'operator');`,
    ]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const call = async (
    sub: string,
    sql: string,
    values: readonly unknown[],
  ): Promise<string> => {
    try {
      await db?.as(
        {
          role: "authenticated",
          settings: {
            "request.jwt.claims": JSON.stringify({
              sub,
              role: "authenticated",
            }),
          },
        },
        async () => {
          await db?.tester.query(sql, [...values]);
        },
      );
      return "ok";
    } catch (error) {
      return error instanceof DatabaseError
        ? `${error.code ?? ""} ${error.hint ?? ""}`.trim()
        : String(error);
    }
  };

  const save = (sub: string, tenant: string | null, scope: string) =>
    call(
      sub,
      "select permdock.permdock_replace_custom_role_grants($1, $2, null, 'reader', array['job.read'], '{}', '{}')",
      [tenant, scope],
    );

  it("refuses a member who holds no manageRoles permission before checking what they may hand out", async () => {
    expect(await save(ADMIN, "acme", "tenant")).toBe("42501 manage-roles");
    expect(await save(MANAGER, "acme", "tenant")).toBe("42501 manage-roles");
    expect(
      await call(
        ADMIN,
        "select permdock.permdock_delete_custom_role_grants('acme', 'tenant', null, 'reader')",
        [],
      ),
    ).toBe("42501 manage-roles");
  });

  it("lets a holder in the tenant or through a global role write", async () => {
    expect(await save(STEWARD, "acme", "tenant")).toBe("ok");
    expect(await save(OPERATOR, "acme", "tenant")).toBe("ok");
    expect(await save(OPERATOR, null, "global")).toBe("ok");
    expect(await save(STEWARD, null, "global")).toBe("42501 not-member");
  });
});

describe("custom-role functions keyed by the role row id", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-custom-role-by-id-"));
  const AUDITOR = "00000000-0000-4000-8000-00000000e001";
  const OUTSIDER = "00000000-0000-4000-8000-00000000e002";
  const SYSTEM = "00000000-0000-4000-8000-00000000e003";
  const MISSING = "00000000-0000-4000-8000-00000000e009";

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: BY_ID_FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([
      `${SETUP}
create role role_reader nologin;
grant role_reader to tester;
create table public.roles (
  id uuid primary key,
  organization_id text,
  key text not null,
  is_system boolean not null default false
);
insert into public.roles values
  ('${AUDITOR}', 'acme', 'auditor', false),
  ('${OUTSIDER}', 'other', 'outsider', false),
  ('${SYSTEM}', 'acme', 'admin', true);
create table public.audit_log (event_type text, target_type text, record_id text, tenant text, metadata jsonb, source text);
create function public.audit_event(event_type text, target_type text, record_id text, tenant text, metadata jsonb, source text)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_log values (event_type, target_type, record_id, tenant, metadata, source)
$$;`,
      readFileSync(out, "utf8"),
    ]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const started = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };

  const saveById = async (
    sub: string,
    id: string,
    permissions: readonly string[],
  ): Promise<string> => {
    try {
      await started().as(
        {
          role: "authenticated",
          settings: {
            "request.jwt.claims": JSON.stringify({
              sub,
              role: "authenticated",
            }),
          },
        },
        async () => {
          await started().tester.query(
            "select permdock.permdock_replace_custom_role_grants_by_id($1, $2)",
            [id, [...permissions]],
          );
        },
      );
      return "ok";
    } catch (error) {
      return error instanceof DatabaseError
        ? `${error.code ?? ""} ${error.hint ?? ""}`.trim()
        : String(error);
    }
  };

  it("saves a role by id with the row's tenant and writes the audit row", async () => {
    const pg = started();
    await pg.admin.query("begin");
    const read = async () => {
      await pg.admin.query("set local role authenticated");
      await pg.admin.query(
        "select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: ADMIN, role: "authenticated" })],
      );
      await pg.admin.query(
        "select permdock.permdock_replace_custom_role_grants_by_id($1, $2)",
        [AUDITOR, ["job.read"]],
      );
      await pg.admin.query("reset role");
      return {
        stored: await pg.admin.query<{ entry: string }>(
          "select tenant_id || '/' || scope || '/' || role || '/' || permission as entry from permdock.custom_role_permissions where role = 'auditor'",
        ),
        audit: await pg.admin.query("select * from public.audit_log"),
      };
    };
    let result: Awaited<ReturnType<typeof read>>;
    try {
      result = await read();
    } finally {
      await pg.admin.query("rollback");
    }
    const { stored, audit } = result;
    expect(stored.rows.map((row) => row.entry)).toStrictEqual([
      "acme/tenant/auditor/job.read",
    ]);
    expect(audit.rows).toStrictEqual([
      {
        event_type: "permdock.custom_role.replaced",
        target_type: "role",
        record_id: AUDITOR,
        tenant: "acme",
        metadata: {
          operation: "replace",
          role: "auditor",
          permissions: ["job.read"],
        },
        source: "permdock",
      },
    ]);
  });

  it("refuses a role id of another tenant, an unknown key, a missing row and a system row", async () => {
    expect(await saveById(ADMIN, OUTSIDER, ["job.read"])).toBe(
      "42501 not-member",
    );
    expect(await saveById(ADMIN, AUDITOR, ["job.delete"])).toBe(
      "22023 unknown-permission",
    );
    expect(await saveById(ADMIN, MISSING, ["job.read"])).toBe(
      "P0002 unknown-role",
    );
    expect(await saveById(ADMIN, SYSTEM, ["job.read"])).toBe(
      "22023 declared-role",
    );
    expect(await saveById(MANAGER, AUDITOR, ["job.update@all"])).toBe(
      "42501 not-assignable-by",
    );
  });

  it("keeps the trusted writer and reader away from client roles", async () => {
    const pg = started();
    const codeAs = (role: string, sql: string): Promise<string> =>
      pg
        .as({ role, settings: {} }, () => pg.tester.query(sql, [[AUDITOR]]))
        .then(
          () => "ok",
          (error: unknown) =>
            error instanceof DatabaseError ? (error.code ?? "") : "",
        );
    const write =
      "select permdock.permdock_trusted_replace_custom_role_grants_by_id(($1::uuid[])[1], array['job.read'])";
    const read =
      "select * from permdock.permdock_trusted_role_permissions_by_id($1::text[])";
    expect(await codeAs("authenticated", write)).toBe("42501");
    expect(await codeAs("authenticated", read)).toBe("42501");
    expect(await codeAs("anon", read)).toBe("42501");
  });

  it("reads declared allow keys by id for a trusted reader and drops the rest", async () => {
    await started().admin.query(
      "select permdock.permdock_trusted_replace_custom_role_grants_by_id($1, $2)",
      [AUDITOR, ["job.read", "job.update@own"]],
    );
    await started().admin.query(
      "insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect) values ('acme', 'tenant', null, 'auditor', 'job.archive', 'allow')",
    );
    const read = (tenant: string | null) =>
      started().as({ role: "role_reader", settings: {} }, () =>
        started().tester.query<{ role_id: string; permission: string }>(
          "select * from permdock.permdock_trusted_role_permissions_by_id($1::text[], $2)",
          [[AUDITOR, SYSTEM], tenant],
        ),
      );
    expect((await read("acme")).rows).toStrictEqual([
      { role_id: AUDITOR, permission: "job.read" },
      { role_id: AUDITOR, permission: "job.update@own" },
    ]);
    const refused = await started()
      .as({ role: "role_reader", settings: {} }, () =>
        started().tester.query(
          "select * from permdock.permdock_trusted_role_permissions_by_id($1::text[], 'acme')",
          [[OUTSIDER]],
        ),
      )
      .then(
        () => "ok",
        (error: unknown) =>
          error instanceof DatabaseError
            ? `${error.code ?? ""} ${error.hint ?? ""}`
            : String(error),
      );
    expect(refused).toBe("42501 not-member");
  });
});
