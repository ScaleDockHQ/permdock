import { describe, expect, it } from "vitest";

import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";
import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type { SqlMembershipSource } from "../../src/supabase/sources.ts";

import { pd097 } from "../../src/cli/doctor/seed-data.ts";
import { FIXTURES_MARKER } from "../../src/cli/rls/emit/seed-sql.ts";
import { compileGrants } from "../../src/cli/sql/compile.ts";
import {
  checkSources,
  hookMemberships,
} from "../../src/cli/supabase-hook/memberships.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { junctionMembershipSource } from "../../src/supabase/sources.ts";

const scopes = [
  { name: "org", key: "org_id" },
  { name: "team", key: "team_id", within: "org" },
] as const;

describe("hook memberships", () => {
  it("keeps an explicit source list and builds nothing from an empty map", () => {
    const given = [
      junctionMembershipSource({
        table: "public.members",
        scope: "org",
        roles: "role",
      }),
    ];
    expect(hookMemberships(given, undefined, scopes)).toBe(given);
    expect(hookMemberships(undefined, undefined, scopes)).toStrictEqual([]);
    expect(hookMemberships(undefined, {}, scopes)).toStrictEqual([]);
  });

  it("builds a junction per scope table, including ancestors, expiry and a role list", () => {
    const built = hookMemberships(
      undefined,
      {
        scopes: {
          team: {
            table: "public.team_members",
            user: "user_id",
            role: "role",
            id: "id",
            columns: { team: "team_id", org: "org_id" },
            expiresAt: "until",
            disabledAt: "disabled_at",
            via: { value: "staff" },
          },
          org: { table: "public.members", user: "user_id", role: ["admin"] },
          nope: {
            table: "public.other",
            user: "user_id",
            role: "role",
            id: "id",
          },
        },
      },
      scopes,
    );
    expect(built.map((source) => source.sql.table)).toStrictEqual([
      "public.team_members",
      "public.members",
      "public.other",
    ]);
    expect(built[0]?.sql.holds).toStrictEqual(["team", "org"]);
    expect(built[0]?.sql.scope).toBe("team");
    expect(built[1]?.sql.holds).toStrictEqual(["org"]);
    expect(built[2]?.sql.scope).toBe("nope");
  });

  it("refuses an empty list, a foreign scope and a membership that drops an ancestor", () => {
    expect(() => checkSources({ sources: [], scopes })).toThrow(
      /needs at least one/u,
    );
    // SAFETY: the object is not a membership source; the guard must refuse it.
    const foreign = { sql: { select: "no" } } as unknown as SqlMembershipSource;
    expect(() => checkSources({ sources: [foreign], scopes })).toThrow(
      /from permdock\/supabase/u,
    );
    const aliased = junctionMembershipSource({
      table: "public.members",
      scope: "tenant",
      roles: "role",
    });
    expect(() => checkSources({ sources: [aliased], scopes })).toThrow(
      /does not declare by that name/u,
    );
    const nested = junctionMembershipSource({
      table: "public.team_members",
      scope: "team",
      roles: "role",
    });
    expect(() => checkSources({ sources: [nested], scopes })).toThrow(
      /needs within columns for org/u,
    );
    const held = junctionMembershipSource({
      table: "public.team_members",
      scope: "team",
      roles: "role",
      within: { org: "org_id" },
    });
    expect(() => checkSources({ sources: [held], scopes })).not.toThrow();
  });
});

describe("PD097 files", () => {
  function files(tree: Readonly<Record<string, string>>): DoctorFiles {
    const paths = new Set(Object.keys(tree));
    return {
      exists: (path) =>
        [...paths].some((item) => item === path || item.startsWith(`${path}/`)),
      read: (path) => tree[path] ?? "",
      list: (dir) =>
        [...paths]
          .filter((item) => item.startsWith(`${dir}/`))
          .map((item) => item.slice(dir.length + 1).split("/")[0] ?? "")
          .filter(
            (name, index, all) => name !== "" && all.indexOf(name) === index,
          ),
      isDirectory: (path) =>
        [...paths].some((item) => item.startsWith(`${path}/`)),
    };
  }

  const permissions = definePermissions({
    note: resource({ actions: ["read"] }),
  });
  const policy = definePolicy(permissions, {
    subject: () => null,
    roles: [role("reader", [allow(permissions.note.read)])],
  });

  it("ignores a known default and a schema file, and warns when the seed path is missing", async () => {
    const cwd = "/app";
    const tree = {
      "/app/supabase/schemas/permdock/helpers.sql":
        "create table public.notes (id int);\n",
      "/app/supabase/schemas/permdock/notes.txt": "not sql\n",
      "/app/supabase/migrations/nested/skip.sql": "select 1;\n",
      "/app/supabase/seeds/permdock.sql": "-- fixtures\n",
    };
    const findings = await pd097({
      cwd,
      files: files(tree),
      config: {
        seeds: {
          defaults: {
            roles: [{ key: "reader", scope: "global", grants: ["note.read"] }],
          },
          fixtures: {
            users: {},
            tenants: {},
            memberships: [],
            customRoles: [],
            rows: {},
          },
        },
      },
      policy: () => Promise.resolve(policy),
    });
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "supabase/config.toml does not list supabase/seeds/permdock.sql. Add:\n[db.seed]\nsql_paths = ['./seeds/permdock.sql']",
    ]);
  });

  it("flags fixture SQL in a migration and stays quiet when config.toml lists the seed", async () => {
    const cwd = "/app";
    const marked = await pd097({
      cwd,
      files: files({
        "/app/supabase/migrations/20260101000000_seed.sql": `${FIXTURES_MARKER}\ninsert into t values (1);\n`,
        "/app/supabase/seeds/permdock.sql": "-- fixtures\n",
        "/app/supabase/config.toml":
          "[db.seed]\nsql_paths = ['./seeds/permdock.sql']\n",
      }),
      config: {},
      policy: () => Promise.resolve(undefined),
    });
    expect(marked.map((finding) => finding.code)).toStrictEqual(["PD097"]);
    expect(marked[0]?.message).toContain("fixture seed data");
    expect(marked.some((finding) => finding.severity === "warning")).toBe(
      false,
    );
  });
});

describe("compileGrants unmapped verbs", () => {
  const ctx: RlsSqlContext = {
    dialect: "supabase",
    scopes: scopeList(undefined),
    tenantClaim: "tenant_id",
    gucPrefix: "app",
  };

  it("names one verb in the singular", () => {
    const permissions = definePermissions({
      note: resource({ actions: ["export"] }),
    });
    const policy = definePolicy(permissions, {
      subject: () => null,
      roles: [role("reader", [allow(permissions.note.export)])],
    });
    expect(() => compileGrants(policy, ctx, undefined, [], false)).toThrow(
      /'export' verb has no rls.actions entry/u,
    );
  });
});
