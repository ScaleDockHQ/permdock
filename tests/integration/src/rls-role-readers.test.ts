import type { CustomRole } from "permdock";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCustomRole } from "permdock";
import { parseCatalog } from "permdock/catalog";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { policy } from "../fixtures/rls-custom-roles/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/rls-custom-roles");

const PLUS = "00000000-0000-4000-8000-0000000000a1";
const GLOBEX = "00000000-0000-4000-8000-0000000000e5";
const REVIEWER = "00000000-0000-4000-8000-0000000000d4";

const REVIEWER_ROLE: CustomRole = {
  tenant: "acme",
  team: "t1",
  name: "reviewer",
  grants: [{ permission: "board.read" }],
};

const CUSTOM_ROLES: readonly CustomRole[] = [
  {
    tenant: "acme",
    name: "editor-plus",
    includes: ["viewer"],
    grants: [
      { permission: "task.update" },
      { permission: "project.read", effect: "deny" },
    ],
  },
  { tenant: "acme", name: "writer", includes: ["member"] },
  {
    tenant: "acme",
    name: "grabby",
    includes: ["owner", "auditor"],
    grants: [{ permission: "project.delete" }],
  },
  REVIEWER_ROLE,
  { tenant: "globex", name: "writer", grants: [{ permission: "task.read" }] },
];

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
grant usage on schema public to authenticated, anon, tester;
insert into auth.users (id) values ('${PLUS}'), ('${GLOBEX}'), ('${REVIEWER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.team_members (
  team_id text not null,
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${PLUS}', 'editor-plus'),
  ('globex', '${GLOBEX}', 'writer');
insert into public.team_members values ('t1', 'acme', '${REVIEWER}', 'reviewer');
create table public.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.task (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  locked boolean not null default false
);
create table public.board (id text primary key, "orgId" text not null, "teamId" text not null);
`;

const quote = (value: string): string => `'${value}'`;

function seed(role: CustomRole): string {
  const scope = role.team === undefined ? "tenant" : "team";
  const scopeId = role.team === undefined ? "null" : quote(role.team);
  const head = `${quote(role.tenant ?? "")}, ${quote(scope)}, ${scopeId}, ${quote(role.name)}`;
  const rows = [
    ...(role.grants ?? []).map(
      (grant) =>
        `insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect) values (${head}, ${quote(grant.permission)}, ${quote(grant.effect ?? "allow")})`,
    ),
    ...(role.includes ?? []).map(
      (name) =>
        `insert into permdock.custom_role_includes (tenant_id, scope, scope_id, role, include_role) values (${head}, ${quote(name)})`,
    ),
  ];
  return rows.join(";\n");
}

type Row = { readonly permission: string; readonly effect: string };

const sorted = (rows: readonly Row[]): string[] =>
  [...new Set(rows.map((row) => `${row.permission}:${row.effect}`))].toSorted();

function declared(name: string, scope: string): string[] {
  const rows: Row[] = [];
  for (const binding of policy.roles) {
    if (binding.name !== name) {
      continue;
    }
    for (const grant of binding.grants) {
      const own = grant.scope === "global" ? "global" : grant.scope;
      if (own === scope) {
        rows.push({ permission: grant.permission.key, effect: grant.effect });
      }
    }
  }
  return sorted(rows);
}

function custom(role: CustomRole): string[] {
  return sorted(
    resolveCustomRole(policy, role).grants.map((grant) => ({
      permission: grant.permission.key,
      effect: grant.effect,
    })),
  );
}

describe("permdock_role_permissions and permdock_permission_keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-role-readers-"));
  let db: Postgres | undefined;
  let catalogKeys: string[] = [];

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}`);
    }
    const catalog = await run(["catalog"], { cwd: FIXTURE });
    if (catalog.code !== 0) {
      throw new Error(`catalog: ${catalog.stdout}`);
    }
    catalogKeys = parseCatalog(catalog.stdout)
      .permissions.map((permission) => permission.key)
      .toSorted();
    db = await startPostgres([
      SETUP,
      readFileSync(out, "utf8"),
      CUSTOM_ROLES.map(seed).join(";\n"),
    ]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const as = async <T>(
    role: "authenticated" | "anon",
    user: string | undefined,
    work: (query: Postgres["tester"]["query"]) => Promise<T>,
  ): Promise<T> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    return target.as(
      {
        role,
        settings: {
          "request.jwt.claims": JSON.stringify(
            user === undefined ? { role } : { sub: user, role },
          ),
        },
      },
      () => work(target.tester.query.bind(target.tester)),
    );
  };

  const read = async (
    user: string | undefined,
    role: string,
    scope: string,
    tenant: string | null = null,
    scopeId: string | null = null,
  ): Promise<string[]> =>
    as("authenticated", user, async (query) => {
      const result = await query<Row>(
        "select permission, effect from permdock.permdock_role_permissions($1, $2, $3, $4)",
        [role, scope, tenant, scopeId],
      );
      return sorted(result.rows);
    });

  it("lists every declared key like the catalog", async () => {
    const keys = await as("authenticated", PLUS, async (query) => {
      const result = await query<{ key: string }>(
        "select permdock.permdock_permission_keys() as key",
      );
      return result.rows.map((row) => row.key);
    });
    expect(keys).toEqual(catalogKeys);
    expect(keys).toContain("board.update");
  });

  it("lists the keys some declared role holds on one scope", async () => {
    const keysOn = (scope: string): Promise<string[]> =>
      as("authenticated", PLUS, async (query) => {
        const result = await query<{ key: string }>(
          "select permdock.permdock_permission_keys($1) as key",
          [scope],
        );
        return result.rows.map((row) => row.key);
      });
    const allowedOn = (scope: string): string[] =>
      [
        ...new Set(
          policy.roles.flatMap((binding) =>
            binding.grants
              .filter(
                (grant) =>
                  grant.effect === "allow" &&
                  (grant.scope === "global" ? "global" : grant.scope) === scope,
              )
              .map((grant) => grant.permission.key),
          ),
        ),
      ].toSorted();
    const scopes = ["global", "tenant", "team"];
    const got = [
      await keysOn("global"),
      await keysOn("tenant"),
      await keysOn("team"),
    ];
    expect(got).toEqual(scopes.map(allowedOn));
    expect(got.flat().every((key) => catalogKeys.includes(key))).toBe(true);
    expect(await keysOn("nowhere")).toEqual([]);
  });

  it("matches the declared roles of the policy on every scope", async () => {
    for (const name of ["auditor", "owner", "admin", "member", "viewer"]) {
      for (const scope of ["global", "tenant", "team"]) {
        expect(await read(PLUS, name, scope)).toEqual(declared(name, scope));
      }
    }
    expect(await read(PLUS, "lead", "team")).toEqual(declared("lead", "team"));
    expect(await read(PLUS, "member", "tenant")).toContain("task.update:deny");
    expect(await read(PLUS, "nobody", "tenant", "acme")).toEqual([]);
  });

  it("matches resolveCustomRole for each custom role of the tenant", async () => {
    for (const role of CUSTOM_ROLES) {
      const user = role.tenant === "globex" ? GLOBEX : PLUS;
      const got =
        role.team === undefined
          ? await read(user, role.name, "tenant", role.tenant)
          : await read(PLUS, role.name, "team", role.tenant, role.team);
      expect(got, `${role.tenant} ${role.name}`).toEqual(custom(role));
    }
    expect(await read(PLUS, "editor-plus", "tenant", "acme")).toEqual(
      expect.arrayContaining(["task.update:allow", "task.read:allow"]),
    );
    expect(await read(PLUS, "editor-plus", "tenant", "acme")).not.toContain(
      "project.read:allow",
    );
    expect(await read(PLUS, "grabby", "tenant", "acme")).not.toContain(
      "project.delete:allow",
    );
  });

  it("answers a custom role to a member of its tenant or instance only", async () => {
    await expect(
      read(GLOBEX, "writer", "tenant", "acme"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      read(PLUS, "writer", "tenant", "globex"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      read(undefined, "writer", "tenant", "acme"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      read(GLOBEX, "reviewer", "team", "acme", "t1"),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await read(REVIEWER, "reviewer", "team", "acme", "t1")).toEqual(
      custom(REVIEWER_ROLE),
    );
    await expect(read(PLUS, "writer", "global")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(read(PLUS, "writer", "nowhere", "acme")).rejects.toMatchObject(
      { code: "22023" },
    );
    await expect(read(PLUS, "writer", "tenant")).rejects.toMatchObject({
      code: "22023",
    });
  });

  it("is executable by authenticated and not by anon", async () => {
    await expect(
      as("anon", undefined, (query) =>
        query("select permdock.permdock_permission_keys()"),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      as("anon", undefined, (query) =>
        query(
          "select * from permdock.permdock_role_permissions('admin', 'tenant')",
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("answers any tenant's custom role through the trusted reader, which no client role may execute", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    for (const role of CUSTOM_ROLES) {
      const result = await db.admin.query<Row>(
        "select permission, effect from permdock.permdock_trusted_role_permissions($1, $2, $3, $4)",
        [
          role.name,
          role.team === undefined ? "tenant" : "team",
          role.tenant,
          role.team ?? null,
        ],
      );
      expect(sorted(result.rows), `${role.tenant} ${role.name}`).toEqual(
        custom(role),
      );
    }
    const admin = await db.admin.query<Row>(
      "select permission, effect from permdock.permdock_trusted_role_permissions('admin', 'tenant')",
    );
    expect(sorted(admin.rows)).toEqual(declared("admin", "tenant"));
    await expect(
      db.admin.query(
        "select * from permdock.permdock_trusted_role_permissions('writer', 'nowhere', 'acme')",
      ),
    ).rejects.toMatchObject({ code: "22023" });
    for (const role of ["authenticated", "anon"] as const) {
      await expect(
        as(role, role === "anon" ? undefined : GLOBEX, (query) =>
          query(
            "select * from permdock.permdock_trusted_role_permissions('writer', 'tenant', 'acme')",
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});
