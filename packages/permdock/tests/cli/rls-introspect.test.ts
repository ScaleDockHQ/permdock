import { describe, expect, it } from "vitest";

import type { ActualRls } from "../../src/cli/rls/introspect.ts";

import { run } from "../../src/cli/core/run.ts";
import {
  diffMixed,
  diffRls,
  expectedRls,
  introspectMixed,
  introspectRls,
  missingIndexes,
  normalizeTableName,
} from "../../src/cli/rls/introspect.ts";
import { fakeSql } from "../fakes/sql.ts";

const SQL = `create or replace function "app".permdock_has(p_grant text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select true $$;
create or replace function "app".guard()
returns trigger
language plpgsql
as $$ begin return new; end $$;`;

const expected = expectedRls(
  [
    {
      name: "post_select",
      table: "post",
      command: "select",
      effect: "allow",
      roles: ["authenticated"],
      using: "true",
    },
    {
      name: "deny_post_delete",
      table: "post",
      command: "delete",
      effect: "deny",
      roles: ["authenticated"],
      using: "false",
    },
  ],
  SQL,
);

const clean: ActualRls = {
  policies: [
    {
      table: "public.post",
      name: "post_select",
      command: "select",
      permissive: true,
      roles: ["authenticated"],
    },
    {
      table: "public.post",
      name: "deny_post_delete",
      command: "delete",
      permissive: false,
      roles: ["authenticated"],
    },
  ],
  leadingColumns: {},
  rlsEnabled: { "public.post": true },
  grants: { "public.post": { authenticated: ["select"] } },
  helpers: {
    "app.permdock_has": { securityDefiner: true, emptySearchPath: true },
  },
};

describe("rls verify --introspect", () => {
  it("expects the security definer helpers, table grants and policies generate writes", () => {
    expect(normalizeTableName('"app"."post"')).toBe("app.post");
    expect(expected.helpers).toEqual(["app.permdock_has"]);
    expect(expected.tables).toEqual(["public.post"]);
    expect(expected.grants).toEqual({
      "public.post": { anon: [], authenticated: ["select"] },
    });
    expect(diffRls(expected, clean)).toEqual([]);
  });

  it("names each difference", () => {
    expect(
      diffRls(expected, {
        ...clean,
        policies: [
          {
            table: "public.post",
            name: "deny_post_delete",
            command: "all",
            permissive: true,
            roles: ["anon", "authenticated"],
          },
        ],
        grants: { "public.post": {} },
        helpers: {},
      }),
    ).toEqual([
      "public.post: policy post_select is missing",
      "public.post: policy deny_post_delete is for all, expected delete",
      "public.post: policy deny_post_delete is permissive, expected restrictive",
      "public.post: policy deny_post_delete applies to anon, authenticated, expected authenticated",
      "public.post: authenticated lacks select, so the policy answers 42501 instead of filtering",
      "app.permdock_has: helper is missing",
    ]);
    expect(diffRls(expected, { ...clean, rlsEnabled: {} })).toEqual([
      "public.post: table is missing",
    ]);
    expect(
      diffRls(
        expected,
        { ...clean, grants: { "public.post": {} } },
        { columnGrants: true },
      ),
    ).toEqual([]);
  });

  it("warns about each index target no index starts with", () => {
    const indexed = expectedRls([], SQL, [
      { table: "post", columns: ["author_id"] },
      { table: "app.memberships", columns: ["user_id", "org_id"] },
    ]);
    expect(
      missingIndexes(indexed, {
        ...clean,
        leadingColumns: {
          "public.post": ["id", "author_id"],
          "app.memberships": ["org_id"],
        },
      }),
    ).toEqual([
      "warning: app.memberships: no index starts with user_id, which the policies or helpers filter on; add it, or write it with rls generate --split ...,indexes",
    ]);
  });

  it("does not check a target on a column the table lacks", () => {
    const indexed = expectedRls([], SQL, [
      { table: "post", columns: ["author_id"] },
      { table: "post", columns: ["org_id"] },
    ]);
    expect(
      missingIndexes(indexed, {
        ...clean,
        leadingColumns: { "public.post": ["id"] },
        columns: { "public.post": ["id", "author_id"] },
      }),
    ).toEqual([
      "warning: public.post: no index starts with author_id, which the policies or helpers filter on; add it, or write it with rls generate --split ...,indexes",
    ]);
  });

  it("needs --db-url", async () => {
    const result = await run(["rls", "verify", "--introspect"]);
    expect(result.code).toBe(2);
    expect(result.stderr + result.stdout).toContain(
      "rls verify --introspect needs --db-url",
    );
  });
});

describe("diffRls details", () => {
  it("names restrictive, extra, disabled, over-granted and unsafe helpers", () => {
    const permissive = expectedRls(
      [
        {
          name: "post_select",
          table: "post",
          command: "select",
          effect: "allow",
          roles: ["anon"],
          using: "true",
        },
      ],
      SQL,
    );
    expect(
      diffRls(permissive, {
        policies: [
          {
            table: "public.post",
            name: "post_select",
            command: "select",
            permissive: false,
            roles: ["anon"],
          },
          {
            table: "public.post",
            name: "hand_written",
            command: "all",
            permissive: true,
            roles: ["authenticated"],
          },
          {
            table: "public.post",
            name: "hand_guard",
            command: "delete",
            permissive: false,
            roles: ["authenticated"],
          },
          {
            table: "public.other",
            name: "elsewhere",
            command: "all",
            permissive: true,
            roles: ["anon"],
          },
        ],
        leadingColumns: {},
        rlsEnabled: { "public.post": true },
        grants: { "public.post": { anon: ["select", "delete"] } },
        helpers: {
          "app.permdock_has": {
            securityDefiner: false,
            emptySearchPath: false,
          },
        },
      }),
    ).toEqual([
      "public.post: policy post_select is restrictive, expected permissive",
      "public.post: policy hand_written is not generated (permissive all); a permissive one widens access",
      "public.post: policy hand_guard is not generated (restrictive delete); a permissive one widens access",
      "public.post: anon holds delete, which no generated policy allows",
      "app.permdock_has: helper is not security definer",
      "app.permdock_has: helper does not set search_path = ''",
    ]);
    expect(
      diffRls(permissive, {
        policies: [],
        leadingColumns: {},
        rlsEnabled: { "public.post": false },
        grants: {},
        helpers: {},
      }),
    ).toEqual([
      "public.post: policy post_select is missing",
      "public.post: row level security is disabled",
      "app.permdock_has: helper is missing",
    ]);
    expect(
      diffRls(
        { ...permissive, grants: {} },
        {
          ...clean,
          policies: [],
          leadingColumns: {},
          rlsEnabled: { "public.post": true },
          grants: {},
        },
      ),
    ).toEqual(["public.post: policy post_select is missing"]);
  });
});

describe("introspectRls and introspectMixed through an injected client", () => {
  it("reads Neon roles, the all command and both search_path spellings", async () => {
    const sql = fakeSql((call) => {
      if (call.sql.includes("roles::text[] as roles")) {
        return {
          rows: [
            {
              target: "public.post",
              policyname: "post_all",
              cmd: "*",
              permissive: "permissive",
              roles: ["anonymous", "authenticated"],
            },
            {
              target: "public.post",
              policyname: "odd",
              cmd: null,
              permissive: "RESTRICTIVE",
              roles: "{x}",
            },
          ],
        };
      }
      if (call.sql.includes("as enabled")) {
        return {
          rows: [
            { target: "public.post", enabled: true },
            { target: "public.off", enabled: "yes" },
          ],
        };
      }
      if (call.sql.includes("role_table_grants")) {
        return {
          rows: [
            {
              target: "public.post",
              grantee: "anonymous",
              privilege: "select",
            },
            {
              target: "public.post",
              grantee: "anonymous",
              privilege: "update",
            },
          ],
        };
      }
      if (call.sql.includes("p.prosecdef")) {
        return {
          rows: [
            { target: "app.a", definer: true, config: "search_path=''" },
            {
              target: "app.b",
              definer: "true",
              config: "search_path=public,work_mem=1",
            },
          ],
        };
      }
      return undefined;
    });
    expect(
      await introspectRls("postgres://fake", expected, sql.connect),
    ).toEqual({
      policies: [
        {
          table: "public.post",
          name: "post_all",
          command: "all",
          permissive: true,
          roles: ["anon", "authenticated"],
        },
        {
          table: "public.post",
          name: "odd",
          command: "",
          permissive: false,
          roles: [],
        },
      ],
      leadingColumns: {},
      columns: {},
      rlsEnabled: { "public.post": true, "public.off": false },
      grants: { "public.post": { anon: ["select", "update"] } },
      helpers: {
        "app.a": { securityDefiner: true, emptySearchPath: true },
        "app.b": { securityDefiner: false, emptySearchPath: false },
      },
    });
    expect(sql.calls[0]?.values).toEqual([["public.post"]]);
    expect(sql.ended()).toBe(true);
  });

  it("reads seeds, scopes policies to application schemas and sorts RLS tables", async () => {
    const sql = fakeSql((call) => {
      if (call.sql.includes(".role_permissions")) {
        return {
          rows: [
            {
              role: "a",
              permission: "p",
              grant_key: "p",
              scope: "global",
              effect: "deny",
            },
            {
              role: "b",
              permission: "p",
              grant_key: "p#2",
              scope: "org",
              effect: "allow",
            },
          ],
        };
      }
      if (call.sql.includes("as expression")) {
        return {
          rows: [
            {
              target: "public.post",
              policyname: "p",
              expression: "true",
              command: "update",
              restrictive: false,
              roles: "authenticated,anon",
            },
            {
              target: "storage.objects",
              policyname: "s",
              expression: "true",
              command: "all",
              restrictive: true,
              roles: null,
            },
            { target: "auth.users", policyname: "u", expression: "true" },
            { target: "pg_temp_1.t", policyname: "t", expression: "true" },
          ],
        };
      }
      if (call.sql.includes("c.relrowsecurity")) {
        return {
          rows: [
            { target: "public.zeta" },
            { target: "app.alpha" },
            { target: "realtime.x" },
          ],
        };
      }
      return undefined;
    });
    expect(
      await introspectMixed("postgres://fake", 'my"schema', sql.connect),
    ).toEqual({
      seeds: [
        {
          role: "a",
          permission: "p",
          grantKey: "p",
          scope: "global",
          effect: "deny",
        },
        {
          role: "b",
          permission: "p",
          grantKey: "p#2",
          scope: "org",
          effect: "allow",
        },
      ],
      policies: [
        {
          table: "public.post",
          name: "p",
          expression: "true",
          command: "update",
          restrictive: false,
          roles: ["authenticated", "anon"],
        },
        {
          table: "storage.objects",
          name: "s",
          expression: "true",
          command: "all",
          restrictive: true,
          roles: [],
        },
      ],
      rlsTables: ["app.alpha", "public.zeta"],
    });
    expect(sql.statements()[0]).toContain('from "my""schema".role_permissions');
    expect(sql.ended()).toBe(true);
  });

  it("closes the client when a catalog query fails", async () => {
    const sql = fakeSql(() => ({ code: "42501" }));
    await expect(
      introspectMixed("postgres://fake", "public", sql.connect),
    ).rejects.toThrow("SQLSTATE 42501");
    expect(sql.ended()).toBe(true);
  });
});

describe("diffMixed", () => {
  const seed = {
    role: "admin",
    permission: "asset.update",
    grantKey: "asset.update",
    scope: "organization",
    effect: "allow",
  } as const;
  const mixed = {
    schema: "public",
    seeds: [seed],
    permissions: ["asset.update", "quote.read"],
    rowConditions: ["quote.read"],
  };

  it("diffs seeds exactly and checks every hand-written policy key", () => {
    const result = diffMixed(mixed, {
      seeds: [
        { ...seed, grantKey: "asset.delete", permission: "asset.delete" },
      ],
      policies: [
        {
          table: "public.asset",
          name: "assets_update",
          expression:
            "(organization_id IN ( SELECT public.permitted_organization_ids('asset.update'::text)))",
        },
        {
          table: "public.quote",
          name: "quotes_select",
          expression:
            "(organization_id IN ( SELECT public.permitted_organization_ids('quote.read'::text)))",
        },
        {
          table: "public.note",
          name: "notes_select",
          expression: "public.permdock_has('note.read'::text)",
        },
      ],
      rlsTables: [
        "public.asset",
        "public.legacy",
        "public.note",
        "public.quote",
      ],
    });
    expect(result.drift).toEqual([
      "public.role_permissions: missing admin allow asset.update on organization",
      "public.role_permissions: unexpected admin allow asset.delete on organization",
      "public.quote: policy quotes_select passes quote.read, whose grants carry row conditions the helpers do not check: the policy grants more than the application does",
      "public.note: policy notes_select passes note.read, which the policy does not declare, so it always denies",
    ]);
    expect(result.info).toEqual([
      "public.legacy: no policy calls a PermDock helper",
    ]);
  });

  it("counts a key-less member helper call as coverage", () => {
    const result = diffMixed(mixed, {
      seeds: [seed],
      policies: [
        {
          table: "public.asset",
          name: "assets_select",
          expression:
            "(organization_id IN ( SELECT public.member_organization_ids()))",
        },
      ],
      rlsTables: ["public.asset"],
    });
    expect(result).toEqual({ drift: [], info: [] });
  });

  it("with rls.readOnlyActors, names each write a client reaches without permdock_actor_may_write", () => {
    const write = (
      table: string,
      name: string,
      command: string,
      expression: string,
      restrictive = false,
      roles: readonly string[] = ["authenticated"],
    ) => ({ table, name, command, expression, restrictive, roles });
    const helper =
      "(organization_id IN ( SELECT public.permitted_organization_ids('asset.update'::text)))";
    const guard =
      "( SELECT public.permdock_actor_may_write() AS permdock_actor_may_write)";
    const policies = [
      write("public.asset", "assets_update", "update", helper),
      write("public.asset", "assets_ro", "all", guard, true),
      write(
        "public.quote",
        "quotes_insert",
        "insert",
        `${helper} AND ${guard}`,
      ),
      write("public.quote", "quotes_delete", "delete", helper),
      write("public.quote", "quotes_select", "select", helper),
      write("public.note", "notes_update", "update", helper, false, [
        "service_role",
      ]),
    ];
    const actual = { seeds: [seed], policies, rlsTables: [] };
    expect(diffMixed(mixed, actual).drift).toEqual([]);
    expect(diffMixed({ ...mixed, readOnlyActors: true }, actual).drift).toEqual(
      [
        "public.quote: delete policies for authenticated do not call permdock_actor_may_write(), so a read-only support or impersonation session can write (rls.readOnlyActors)",
      ],
    );
  });
});
