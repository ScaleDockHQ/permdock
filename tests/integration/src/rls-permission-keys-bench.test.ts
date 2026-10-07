import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listPermissions } from "permdock";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions } from "../fixtures/permission-keys-bench/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/permission-keys-bench");

const USERS = {
  admin: "00000000-0000-4000-8000-0000000000f1",
  mixed: "00000000-0000-4000-8000-0000000000f2",
  custom: "00000000-0000-4000-8000-0000000000f3",
  auditor: "00000000-0000-4000-8000-0000000000f4",
} as const;

const REVIEWER = ["area3.read", "area3.update", "area7.delete"];

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
insert into auth.users (id) values ${Object.values(USERS)
  .map((id) => `('${id}')`)
  .join(", ")};
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${USERS.admin}', 'admin'),
  ('acme', '${USERS.mixed}', 'member'),
  ('acme', '${USERS.mixed}', 'editor'),
  ('acme', '${USERS.mixed}', 'frozen'),
  ('globex', '${USERS.mixed}', 'admin'),
  ('acme', '${USERS.custom}', 'reviewer');
`;

const DATABASE_ROWS = `
insert into permdock.custom_role_permissions (tenant_id, role, permission) values
${REVIEWER.map((key) => `  ('acme', 'reviewer', '${key}')`).join(",\n")};
insert into permdock.user_roles (user_id, role) values ('${USERS.auditor}', 'auditor');
`;

const JWT_CLAIMS: Readonly<Record<string, Record<string, unknown>>> = {
  [USERS.admin]: {
    memberships: [{ scope: "tenant", id: "acme", roles: ["admin"] }],
  },
  [USERS.mixed]: {
    memberships: [
      { scope: "tenant", id: "acme", roles: ["member", "editor", "frozen"] },
      { scope: "tenant", id: "globex", roles: ["admin"] },
    ],
  },
  [USERS.custom]: {
    memberships: [
      {
        scope: "tenant",
        id: "acme",
        roles: ["reviewer"],
        grants: { reviewer: REVIEWER },
      },
    ],
  },
  [USERS.auditor]: { user_role: ["auditor"] },
};

const keys = listPermissions(permissions).map((leaf) => leaf.key);

const CASES = [
  [USERS.admin, "acme", {}],
  [USERS.mixed, "acme", {}],
  [USERS.mixed, "globex", {}],
  [
    USERS.mixed,
    "acme",
    { api_key: { scopes: ["area0.read", "area1.update", "area2.read"] } },
  ],
  [USERS.custom, "acme", {}],
  [USERS.auditor, "acme", {}],
] as const;

const median = (values: readonly number[]): number =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

for (const mode of ["database", "jwt"] as const) {
  describe(`permitted_<scope>_permission_keys over 190 keys, ${mode} mode`, () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-permission-keys-bench-"));
    let db: Postgres | undefined;

    beforeAll(async () => {
      const out = join(dir, "rls.sql");
      const result = await run(
        [
          "rls",
          "generate",
          "--target",
          "sql",
          "--authorize",
          mode,
          "--out",
          out,
        ],
        { cwd: FIXTURE },
      );
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}`);
      }
      db = await startPostgres([
        SETUP,
        readFileSync(out, "utf8"),
        mode === "database" ? DATABASE_ROWS : "",
      ]);
    }, 240_000);

    afterAll(async () => {
      rmSync(dir, { recursive: true, force: true });
      await db?.stop();
    });

    it("answers every key in one set-based call, as the per-key helpers do, in under a third of their time", async () => {
      if (db === undefined) {
        throw new Error("PermDock: Postgres was not started");
      }
      const target = db;
      expect(keys.length).toBe(190);
      const results: {
        one: number;
        each: number;
        oneKeys: string[];
        eachKeys: string[];
        filtered: string[];
      }[] = [];
      for (const [user, tenant, extra] of CASES) {
        const claims = {
          sub: user,
          role: "authenticated",
          ...(mode === "jwt" ? JWT_CLAIMS[user] : {}),
          ...extra,
        };
        results.push(
          await target.as(
            {
              role: "authenticated",
              settings: { "request.jwt.claims": JSON.stringify(claims) },
            },
            async () => {
              const query = async (sql: string, values: unknown[]) => {
                const start = performance.now();
                const result = await target.tester.query<{ key: string }>(
                  sql,
                  values,
                );
                return {
                  ms: performance.now() - start,
                  keys: result.rows.map((row) => row.key).toSorted(),
                };
              };
              const one: number[] = [];
              const each: number[] = [];
              let oneKeys: string[] = [];
              let eachKeys: string[] = [];
              for (let round = 0; round < 7; round += 1) {
                const single = await query(
                  "select k as key from permdock.permitted_tenant_permission_keys($1) k",
                  [tenant],
                );
                const perKey = await query(
                  "select k.key from unnest($1::text[]) k(key) where (select permdock.permdock_has_permission(k.key)) or $2 in (select permdock.permitted_tenant_ids_by_permission(k.key))",
                  [keys, tenant],
                );
                one.push(single.ms);
                each.push(perKey.ms);
                oneKeys = single.keys;
                eachKeys = perKey.keys;
              }
              const filtered = await query(
                "select k as key from permdock.permitted_tenant_permission_keys($1, $2) k",
                [tenant, ["area3.read", "area3.update", "area0.read", "ghost"]],
              );
              return {
                one: median(one),
                each: median(each),
                oneKeys,
                eachKeys,
                filtered: filtered.keys,
              };
            },
          ),
        );
      }
      expect(results.map((result) => result.oneKeys)).toEqual(
        results.map((result) => result.eachKeys),
      );
      expect(results.map((result) => result.filtered)).toEqual(
        results.map((result) =>
          result.oneKeys.filter((key) =>
            ["area3.read", "area3.update", "area0.read"].includes(key),
          ),
        ),
      );
      expect(results.map((result) => result.oneKeys.length)).toEqual([
        190, 78, 190, 2, 3, 10,
      ]);
      expect(results.filter((result) => result.one * 3 >= result.each)).toEqual(
        [],
      );
    });

    it.runIf(mode === "database")(
      "answers for a named user with a key filter",
      async () => {
        if (db === undefined) {
          throw new Error("PermDock: Postgres was not started");
        }
        const named = await db.admin.query<{ key: string }>(
          "select k as key from permdock.permitted_tenant_permission_keys_for($1, 'acme', array['area3.read', 'area7.delete', 'area9.read']) k",
          [USERS.custom],
        );
        expect(named.rows.map((row) => row.key)).toEqual([
          "area3.read",
          "area7.delete",
        ]);
        const all = await db.admin.query<{ key: string }>(
          "select k as key from permdock.permitted_tenant_permission_keys_for($1, 'acme') k",
          [USERS.mixed],
        );
        expect(all.rows).toHaveLength(78);
      },
    );
  });
}
