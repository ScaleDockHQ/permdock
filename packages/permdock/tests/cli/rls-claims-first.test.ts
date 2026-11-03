import path from "node:path";
import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type {
  PermDockConfig,
  RoleMap,
  RoleThrough,
} from "../../src/cli/types.ts";

import { runRlsGenerate } from "../../src/cli/rls/generate.ts";
import {
  forUserContext,
  grantBodies,
  helpersSql,
} from "../../src/cli/rls/helpers.ts";
import {
  junctionMembershipSource,
  tableMembershipSource,
} from "../../src/supabase/index.ts";

const scopes = [{ name: "org", key: "org_id" }];

const mapped = {
  table: "org_members",
  user: "user_id",
  role: "role",
  columns: { org: "org_id" },
} as const;

function ctx(extra: Partial<RlsSqlContext> = {}): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes,
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    authorize: "database",
    memberships: { scopes: { org: mapped } },
    ...extra,
  };
}

const helpers = (extra: Partial<RlsSqlContext> = {}) =>
  helpersSql(ctx(extra), [], { userRoles: false });

function fnBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function "permdock".${name}(`);
  return start === -1 ? "" : sql.slice(start, sql.indexOf("$$;", start));
}

function branches(body: string): readonly string[] {
  return body.split("\n  union\n");
}

describe("claims first helpers", () => {
  it("reads the stored version only when the hook keeps it", () => {
    const sql = helpers({ claimsFirst: true });
    expect(sql).toContain(
      'create or replace function "permdock".permdock_token_current()',
    );
    expect(fnBody(sql, "permdock_token_current")).toContain(
      "language plpgsql\nstable\nsecurity definer",
    );
    const body = fnBody(sql, "permdock_token_current");
    expect(body).toContain(
      "to_jsonb(v.version) = ((select auth.jwt()) -> 'authz_ver')",
    );
    expect(body).toContain("memberships_truncated");
    expect(body).toContain(
      "jsonb_typeof((select auth.jwt()) -> 'memberships') = 'array'",
    );
    expect(body).toContain('from "permdock".permdock_authz_version v');
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_token_current() to authenticated;',
    );
  });

  it("gives anon execute when rls.anonExecute is on", () => {
    const sql = helpersSql(ctx({ claimsFirst: true }), [], {
      userRoles: false,
      anonExecute: true,
    });
    expect(sql).toContain(
      'grant execute on function "permdock".permdock_token_current() to anon, authenticated;',
    );
  });

  it("reads the claim when current and the table when stale", () => {
    const body = fnBody(helpers({ claimsFirst: true }), "permitted_org_ids");
    const parts = branches(body);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("select (m ->> 'id')::uuid");
    expect(parts[0]).toContain(
      'and (select "permdock".permdock_token_current())',
    );
    expect(parts[0]).toContain("from jsonb_array_elements(");
    expect(parts[0]).toContain("and m ->> 'scope' = 'org'");
    expect(parts[1]).toContain(
      'and not (select "permdock".permdock_token_current())',
    );
  });

  it("keeps the custom-role table branch in both paths", () => {
    const body = fnBody(
      helpers({
        claimsFirst: true,
        customRoles: { declared: ["admin"], assignable: [] },
      }),
      "permitted_org_ids",
    );
    const parts = branches(body);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toContain("permdock_custom_keys");
    expect(parts[2]).not.toContain("permdock_token_current");
  });

  it("does not read claims without claimsFirst", () => {
    const sql = helpers();
    expect(sql).not.toContain("permdock_token_current");
    expect(fnBody(sql, "permitted_org_ids")).not.toContain(
      "permdock_token_current",
    );
  });

  it("does not claim-read the _for helpers", () => {
    const forBody = grantBodies(forUserContext(ctx({ claimsFirst: true }))).ids(
      "org",
    );
    expect(forBody.sql).not.toContain("permdock_token_current");
    expect(forBody.sql).toContain("= p_user");
  });

  it("does not claim-read the set helpers", () => {
    const setBody = grantBodies({
      ...ctx({ claimsFirst: true }),
      grantSet: true,
    }).ids("org");
    expect(setBody.sql).not.toContain("permdock_token_current");
    expect(setBody.sql).toContain("rp.grant_key");
  });
});

const MINI = path.join(import.meta.dirname, "fixtures/mini-app/src/policy.ts");
const io = { stdout: () => undefined, stderr: () => undefined };

type Input = Parameters<typeof runRlsGenerate>[0];

const tenantTable = {
  table: "memberships",
  user: "user_id",
  role: "role",
  columns: { tenant: "org_id" },
} as const;

const tenantSource = junctionMembershipSource({
  table: "memberships",
  scope: "tenant",
  id: "org_id",
  roles: "role",
  user: "user_id",
});

const teamTable = {
  table: "team_members",
  user: "user_id",
  role: "role",
  columns: { tenant: "org_id", team: "team_id" },
} as const;

const teamSource = junctionMembershipSource({
  table: "team_members",
  scope: "team",
  id: "team_id",
  within: { tenant: "org_id" },
  roles: "role",
  user: "user_id",
});

function config(
  over: {
    readonly rls?: PermDockConfig["rls"];
    readonly hook?: NonNullable<PermDockConfig["supabase"]>["hook"];
  } = {},
): PermDockConfig {
  return {
    policy: MINI,
    rls: { memberships: { scopes: { tenant: tenantTable } }, ...over.rls },
    supabase: { hook: { memberships: [tenantSource], ...over.hook } },
  };
}

function generate(over: Partial<Input> = {}) {
  return runRlsGenerate({
    cwd: import.meta.dirname,
    config: {},
    target: "sql",
    dialect: "supabase",
    authorize: "database",
    rbac: false,
    check: false,
    skipClosures: false,
    inlineFunctions: false,
    io,
    write: false,
    ...over,
  });
}

async function text(over: Partial<Input> = {}): Promise<string> {
  const outcome = await generate(over);
  expect(outcome.code).toBe(0);
  return outcome.text;
}

describe("claims first gating", () => {
  it("turns on for a matching hook source", async () => {
    expect(await text({ config: config() })).toContain(
      "permdock_token_current",
    );
  });

  it("turns off without a hook, a version or a schema", async () => {
    expect(await text({ config: { policy: MINI } })).not.toContain(
      "permdock_token_current",
    );
    expect(
      await text({
        config: config({
          hook: { version: false, memberships: [tenantSource] },
        }),
      }),
    ).not.toContain("permdock_token_current");
    expect(
      await text({
        config: config({
          hook: { schema: "identity", memberships: [tenantSource] },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });

  it("turns off when the hook has its own suspension", async () => {
    expect(
      await text({
        config: config({
          hook: {
            suspension: {
              users: {
                table: "profiles",
                id: "user_id",
                disabledAt: "disabled_at",
              },
            },
            memberships: [tenantSource],
          },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });

  it("turns off outside Supabase database mode or without a mapped table", async () => {
    expect(await text({ config: config(), dialect: "guc" })).not.toContain(
      "permdock_token_current",
    );
    expect(await text({ config: config(), authorize: "jwt" })).not.toContain(
      "permdock_token_current",
    );
    expect(
      await text({
        config: {
          policy: MINI,
          supabase: { hook: { memberships: [tenantSource] } },
        },
      }),
    ).not.toContain("permdock_token_current");
  });

  it("turns off when the source reads another table", async () => {
    expect(
      await text({
        config: config({
          hook: {
            memberships: [
              junctionMembershipSource({
                table: "other_members",
                scope: "tenant",
                id: "org_id",
                roles: "role",
                user: "user_id",
              }),
            ],
          },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });

  it("turns off when the user, id, via, expiry or suspension differ", async () => {
    const variants = [
      junctionMembershipSource({
        table: "memberships",
        scope: "tenant",
        id: "org_id",
        roles: "role",
        user: "member_id",
      }),
      junctionMembershipSource({
        table: "memberships",
        scope: "tenant",
        id: "tenant_id",
        roles: "role",
        user: "user_id",
      }),
      junctionMembershipSource({
        table: "memberships",
        scope: "tenant",
        id: "org_id",
        roles: "role",
        user: "user_id",
        via: "contact",
      }),
      junctionMembershipSource({
        table: "memberships",
        scope: "tenant",
        id: "org_id",
        roles: "role",
        user: "user_id",
        expiresAt: "expires_at",
      }),
      junctionMembershipSource({
        table: "memberships",
        scope: "tenant",
        id: "org_id",
        roles: "role",
        user: "user_id",
        disabledAt: "disabled_at",
      }),
    ];
    for (const source of variants) {
      expect(
        await text({ config: config({ hook: { memberships: [source] } }) }),
      ).not.toContain("permdock_token_current");
    }
  });

  it("turns off when the role source differs", async () => {
    const variants = [
      junctionMembershipSource({
        table: "memberships",
        scope: "tenant",
        id: "org_id",
        roles: "other_role",
        user: "user_id",
      }),
      junctionMembershipSource({
        table: "memberships",
        scope: "tenant",
        id: "org_id",
        roles: ["member"],
        user: "user_id",
      }),
    ];
    for (const source of variants) {
      expect(
        await text({ config: config({ hook: { memberships: [source] } }) }),
      ).not.toContain("permdock_token_current");
    }
  });

  it("turns off when a mapped scope has no scope column", async () => {
    expect(
      await text({
        config: config({
          rls: {
            memberships: {
              scopes: {
                tenant: { table: "memberships", user: "user_id", role: "role" },
              },
            },
          },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });

  it("turns off when an ancestor column differs", async () => {
    expect(
      await text({
        config: config({
          rls: {
            memberships: {
              scopes: {
                tenant: tenantTable,
                team: {
                  ...teamTable,
                  columns: { tenant: "other_org_id", team: "team_id" },
                },
              },
            },
          },
          hook: { memberships: [tenantSource, teamSource] },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });

  it("turns on when both mapped scopes and ancestors match", async () => {
    expect(
      await text({
        config: config({
          rls: {
            memberships: { scopes: { tenant: tenantTable, team: teamTable } },
          },
          hook: { memberships: [tenantSource, teamSource] },
        }),
      }),
    ).toContain("permdock_token_current");
  });

  it("turns off for a guarded source", async () => {
    const guarded = tenantSource.guarded?.({
      table: "roles",
      tenant: "org_id",
      declared: ["admin"],
    });
    if (guarded === undefined) {
      throw new Error("expected a guarded source");
    }
    expect(
      await text({ config: config({ hook: { memberships: [guarded] } }) }),
    ).not.toContain("permdock_token_current");
  });

  it("turns off for a table source that does not name one scope", async () => {
    expect(
      await text({
        config: config({
          hook: {
            memberships: [
              tableMembershipSource({
                table: "memberships",
                columns: {
                  scope: "scope",
                  id: "org_id",
                  user: "user_id",
                  role: "role",
                },
              }),
            ],
          },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });
});

describe("claims first helper branches", () => {
  it("skips the tenant narrowing when rls.tenants is all", () => {
    const body = fnBody(
      helpers({ claimsFirst: true, tenants: "all" }),
      "permitted_org_ids",
    );
    expect(body).not.toContain("nullif(");
  });

  it("joins the active user and filters a kept instance in the claim branch", () => {
    const body = fnBody(
      helpers({
        claimsFirst: true,
        suspension: {
          users: { table: "profiles", id: "id", disabledAt: "disabled_at" },
          scopes: {
            org: {
              table: "organizations",
              id: "id",
              disabledAt: "disabled_at",
              keep: ["post.write"],
            },
          },
        },
        ownership: { kinds: { admin: ["staff"] }, assigns: [], counted: [] },
        permission: "post.read",
      }),
      "permitted_org_ids",
    );
    expect(body).toContain("act_user");
    expect(body).toContain('from "public"."organizations" s');
    expect(body).toContain(
      "case r.role when 'admin' then coalesce(m ->> 'via', '') = any(array['staff']::text[]) else true end",
    );
  });

  it("drops the instance check when the suspension keeps the grant", () => {
    const body = fnBody(
      helpers({
        claimsFirst: true,
        suspension: {
          scopes: {
            org: {
              table: "organizations",
              id: "id",
              disabledAt: "disabled_at",
              keep: ["post.read"],
            },
          },
        },
        permission: "post.read",
      }),
      "permitted_org_ids",
    );
    expect(body).not.toContain("act_org");
    expect(body).toContain(
      'coalesce((m ->> \'id\')::uuid in (select s."id" from "public"."organizations" s where s."disabled_at" is null), false)',
    );
  });

  it("reads a nested instance id from the claim", () => {
    const body = fnBody(
      helpers({
        claimsFirst: true,
        scopes: [{ name: "tenant" }, { name: "team", within: "tenant" }],
        memberships: {
          scopes: {
            tenant: {
              table: "memberships",
              user: "user_id",
              role: "role",
              columns: { tenant: "tenant_id" },
            },
            team: {
              table: "team_members",
              user: "user_id",
              role: "role",
              columns: { tenant: "tenant_id", team: "team_id" },
            },
          },
        },
        suspension: {
          scopes: {
            tenant: { table: "tenants", id: "id", disabledAt: "disabled_at" },
          },
        },
      }),
      "permitted_team_ids",
    );
    expect(body).toContain("act_tenant");
    expect(body).toContain("m -> 'within' ->> 'tenant'");
  });

  it("checks a status-only user without an active list", () => {
    const body = fnBody(
      helpers({
        suspension: {
          users: { table: "profiles", id: "id", status: "status" },
        },
      }),
      "permitted_org_ids",
    );
    expect(body).toContain('act_user."status"::text = any(array[]::text[])');
  });

  it("filters kept rows on the source path", () => {
    const source = junctionMembershipSource({
      table: "org_members",
      scope: "org",
      id: "org_id",
      roles: "role",
      user: "user_id",
      suspension: {
        scopes: {
          org: {
            table: "organizations",
            id: "id",
            disabledAt: "disabled_at",
            keep: ["post.read"],
          },
        },
      },
    });
    const bare: RlsSqlContext = {
      dialect: "supabase",
      scopes,
      tenantClaim: "tenant_id",
      gucPrefix: "app",
      authorize: "database",
      sources: [source],
      suspension: { memberships: { keep: ["post.read"] } },
      permission: "post.read",
    };
    const body = fnBody(
      helpersSql(bare, [], { userRoles: false }),
      "permitted_org_ids",
    );
    expect(body).toContain("ms.keep");
  });

  it("writes an empty role_permissions view without seed rows", () => {
    const sql = helpersSql(ctx({ seeds: "view" }), [], { userRoles: false });
    expect(sql).toContain(
      "select null::text, null::text, null::text, null::text, null::text where false",
    );
  });

  it("writes each via helper once", () => {
    const via = {
      helper: "permitted_org_ids",
      key: "org_id",
      scope: "org",
      table: "public.projects",
      column: "org_id",
      id: "id",
      type: "uuid",
    };
    const sql = helpers({
      vias: { first: via, second: { ...via, table: "public.tasks" } },
    });
    expect(sql).toContain("-- rows of public.projects");
    expect(sql).not.toContain("-- rows of public.tasks");
  });
});

describe("claims first role and kind gating", () => {
  const roleConfig = (role: string | RoleMap | RoleThrough) =>
    config({
      rls: { memberships: { scopes: { tenant: { ...tenantTable, role } } } },
      hook: {
        memberships: [
          junctionMembershipSource({
            table: "memberships",
            scope: "tenant",
            id: "org_id",
            roles: role,
            user: "user_id",
          }),
        ],
      },
    });

  it("matches a role map", async () => {
    const role = { column: "kind", map: { admin: "owner", user: null } };
    expect(await text({ config: roleConfig(role) })).toContain(
      "permdock_token_current",
    );
  });

  it("turns off for a role map with other keys or values", async () => {
    const pairs: readonly (readonly [RoleMap, RoleMap])[] = [
      [
        { column: "kind", map: { admin: "owner" } },
        { column: "kind", map: { admin: "owner", user: null } },
      ],
      [
        { column: "kind", map: { admin: "owner" } },
        { column: "kind", map: { admin: "member" } },
      ],
    ];
    for (const [mappedRole, source] of pairs) {
      expect(
        await text({
          config: config({
            rls: {
              memberships: {
                scopes: { tenant: { ...tenantTable, role: mappedRole } },
              },
            },
            hook: {
              memberships: [
                junctionMembershipSource({
                  table: "memberships",
                  scope: "tenant",
                  id: "org_id",
                  roles: source,
                  user: "user_id",
                }),
              ],
            },
          }),
        }),
      ).not.toContain("permdock_token_current");
    }
  });

  it("matches a role through a roles table", async () => {
    const role = { through: "roles", on: { role_id: "id" }, column: "key" };
    expect(await text({ config: roleConfig(role) })).toContain(
      "permdock_token_current",
    );
  });

  it("turns off for another role table, reference or column", async () => {
    const pairs = [
      [
        { through: "roles", on: { role_id: "id" }, column: "key" },
        { through: "other_roles", on: { role_id: "id" }, column: "key" },
      ],
      [
        { through: "roles", on: { role_id: "role_id" }, column: "key" },
        { through: "roles", on: { role_id: "id" }, column: "key" },
      ],
      [
        { through: "roles", on: { role_id: "id" }, column: "name" },
        { through: "roles", on: { role_id: "id" }, column: "key" },
      ],
      [{ through: "roles", on: { role_id: "id" }, column: "key" }, "role"],
    ] as const;
    for (const [mappedRole, source] of pairs) {
      expect(
        await text({
          config: config({
            rls: {
              memberships: {
                scopes: { tenant: { ...tenantTable, role: mappedRole } },
              },
            },
            hook: {
              memberships: [
                junctionMembershipSource({
                  table: "memberships",
                  scope: "tenant",
                  id: "org_id",
                  roles: source,
                  user: "user_id",
                }),
              ],
            },
          }),
        }),
      ).not.toContain("permdock_token_current");
    }
  });

  it("matches several role columns", async () => {
    expect(
      await text({
        config: config({
          rls: {
            memberships: {
              scopes: {
                tenant: { ...tenantTable, role: ["role_a", "role_b"] },
              },
            },
          },
          hook: {
            memberships: [
              junctionMembershipSource({
                table: "memberships",
                scope: "tenant",
                id: "org_id",
                roles: { sources: ["role_a", "role_b"] },
                user: "user_id",
              }),
            ],
          },
        }),
      }),
    ).toContain("permdock_token_current");
    expect(
      await text({
        config: config({
          rls: {
            memberships: {
              scopes: { tenant: { ...tenantTable, role: ["role_a"] } },
            },
          },
          hook: {
            memberships: [
              junctionMembershipSource({
                table: "memberships",
                scope: "tenant",
                id: "org_id",
                roles: { sources: ["role_a", "role_b"] },
                user: "user_id",
              }),
            ],
          },
        }),
      }),
    ).not.toContain("permdock_token_current");
    expect(
      await text({
        config: config({
          rls: {
            memberships: {
              scopes: { tenant: { ...tenantTable, role: ["role_a", "other"] } },
            },
          },
          hook: {
            memberships: [
              junctionMembershipSource({
                table: "memberships",
                scope: "tenant",
                id: "org_id",
                roles: { sources: ["role_a", "role_b"] },
                user: "user_id",
              }),
            ],
          },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });

  it("turns off for one role column against several", async () => {
    expect(
      await text({
        config: config({
          rls: {
            memberships: {
              scopes: { tenant: { ...tenantTable, role: "role_a" } },
            },
          },
          hook: {
            memberships: [
              junctionMembershipSource({
                table: "memberships",
                scope: "tenant",
                id: "org_id",
                roles: { sources: ["role_a", "role_b"] },
                user: "user_id",
              }),
            ],
          },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });

  it("matches a fixed membership kind", async () => {
    const role = { ...tenantTable, via: { value: "staff" } };
    expect(
      await text({
        config: config({
          rls: { memberships: { scopes: { tenant: role } } },
          hook: {
            memberships: [
              junctionMembershipSource({
                table: "memberships",
                scope: "tenant",
                id: "org_id",
                roles: "role",
                user: "user_id",
                via: "staff",
              }),
            ],
          },
        }),
      }),
    ).toContain("permdock_token_current");
  });

  it("turns off for another kind, a column or a missing kind", async () => {
    const role = { ...tenantTable, via: { value: "staff" } } as const;
    const variants = [
      { role, via: "contact" },
      { role: { ...tenantTable, via: "staff" }, via: "staff" },
      { role, via: undefined },
      { role: tenantTable, via: "staff" },
    ] as const;
    for (const { role: mappedRole, via } of variants) {
      expect(
        await text({
          config: config({
            rls: { memberships: { scopes: { tenant: mappedRole } } },
            hook: {
              memberships: [
                junctionMembershipSource({
                  table: "memberships",
                  scope: "tenant",
                  id: "org_id",
                  roles: "role",
                  user: "user_id",
                  ...(via === undefined ? {} : { via }),
                }),
              ],
            },
          }),
        }),
      ).not.toContain("permdock_token_current");
    }
  });

  it("turns off when the hook source has no ancestor column", async () => {
    expect(
      await text({
        config: config({
          rls: {
            memberships: { scopes: { tenant: tenantTable, team: teamTable } },
          },
          hook: {
            memberships: [
              tenantSource,
              junctionMembershipSource({
                table: "team_members",
                scope: "team",
                id: "team_id",
                roles: "role",
                user: "user_id",
              }),
            ],
          },
        }),
      }),
    ).not.toContain("permdock_token_current");
  });
});
