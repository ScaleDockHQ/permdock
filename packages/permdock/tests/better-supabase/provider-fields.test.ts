import { testAuthorizationProvider } from "better-supabase/testing";
import { describe, expect, it } from "vitest";

import type {
  SupabaseManifest,
  SupabaseManifestMembership,
} from "../../src/supabase/manifest.ts";

import { authorizationProvider } from "../../src/better-supabase/index.ts";
import { betterSupabaseManifest } from "../../src/testing/fixtures/index.ts";
import { supabaseHookManifestFixture } from "../../src/testing/supabase-fixtures.ts";

const catalog = (keys: readonly string[]) => ({
  $schema: "https://permdock.com/schemas/catalog-v2.json",
  version: 2,
  generatedAt: "2026-01-01T00:00:00Z",
  generator: "test",
  resources: {},
  permissions: keys.map((key) => ({
    key,
    scope: key.replace(".", ":"),
    resource: key.split(".")[0],
    action: key.split(".")[1],
    arity: "collection",
    meta: {},
    usages: [],
    rowConditions: false,
  })),
});

const helper = (name: string) => ({
  name,
  args: "",
  returns: "setof uuid",
  execute: ["authenticated"],
});

const withRls = (
  rls: Partial<SupabaseManifest["rls"]>,
  base: SupabaseManifest = betterSupabaseManifest,
): SupabaseManifest => ({ ...base, rls: { ...base.rls, ...rls } });

const teamSource: SupabaseManifestMembership = {
  table: "public.squad_members",
  user: { column: "user_id" },
  scope: { value: "squad" },
  id: { column: "squad_id" },
  role: { value: ["member"] },
  within: { columns: { organization: "organization_id" } },
  columns: ["user_id", "squad_id", "organization_id"],
};

describe("portal and team templates", () => {
  it("fills portalParties and portalSubjects from a child scope with via", async () => {
    const provider = authorizationProvider({
      manifest: betterSupabaseManifest,
    });
    const parties =
      "select m.organization_id::text, 'customer', m.customer_id::text from public.contacts m where m.customer_id in (select permdock.member_customer_ids())";
    expect(provider.functions.portalParties).toBe(`(${parties})`);
    expect(provider.functions.portalSubjects).toBe(
      `(${parties} and m.customer_id in (select permdock.permitted_customer_ids_by_permission('customer.' || {action})))`,
    );
    expect(provider.requires).toContainEqual({
      function: "permdock.member_customer_ids",
      role: "authenticated",
    });
    expect(provider.functions).not.toHaveProperty("teamIdsOf");
    await expect(testAuthorizationProvider(provider)).resolves.toBeDefined();
  });

  it("reads the tenant id from a jsonb within column", () => {
    const [organization, contacts] = betterSupabaseManifest.rls.memberships;
    const provider = authorizationProvider({
      manifest: withRls({
        memberships: [
          ...(organization === undefined ? [] : [organization]),
          ...(contacts === undefined
            ? []
            : [{ ...contacts, within: { column: "ancestors" } }]),
        ],
      }),
    });
    expect(provider.functions.portalParties).toContain(
      "select (m.ancestors ->> 'organization'), 'customer'",
    );
  });

  it("leaves a guest source without the tenant column out, with a problem", () => {
    const [organization, contacts] = betterSupabaseManifest.rls.memberships;
    const { within: _within, ...bare } = contacts ?? teamSource;
    const provider = authorizationProvider({
      manifest: withRls({
        memberships: [
          ...(organization === undefined ? [] : [organization]),
          bare,
        ],
      }),
    });
    expect(provider.functions).not.toHaveProperty("portalParties");
    expect(provider.problems).toContainEqual(
      "public.contacts names no organization column in within, so portalParties and portalSubjects leave out its customer guests.",
    );
  });

  it("takes the one child scope without via as the team scope", () => {
    const provider = authorizationProvider({
      manifest: withRls({
        scopes: [
          ...betterSupabaseManifest.rls.scopes,
          { name: "squad", type: "uuid", within: "organization" },
        ],
        helpers: [
          ...betterSupabaseManifest.rls.helpers,
          helper("member_squad_ids"),
        ],
        memberships: [...betterSupabaseManifest.rls.memberships, teamSource],
      }),
    });
    expect(provider.functions.teamIdsOf).toBe(
      "(select m.id from permdock.member_squad_ids() as m(id) where {user} = (select auth.uid()))",
    );
  });

  it("names no team scope when two child scopes lack via", () => {
    const other = {
      ...teamSource,
      table: "public.crew_members",
      scope: { value: "crew" },
    };
    const provider = authorizationProvider({
      manifest: withRls({
        scopes: [
          ...betterSupabaseManifest.rls.scopes,
          { name: "squad", type: "uuid", within: "organization" },
          { name: "crew", type: "uuid", within: "organization" },
        ],
        helpers: [
          ...betterSupabaseManifest.rls.helpers,
          helper("member_squad_ids"),
          helper("member_crew_ids"),
        ],
        memberships: [
          ...betterSupabaseManifest.rls.memberships,
          teamSource,
          other,
        ],
      }),
    });
    expect(provider.functions).not.toHaveProperty("teamIdsOf");
    expect(provider.problems?.join("\n")).toContain(
      "teamIdsOf: the scopes squad, crew are all within organization without via",
    );
  });
});

describe("versions and wildcards", () => {
  it("names the hook's authz_version_for when the version is on", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
    });
    expect(provider.versions).toStrictEqual({
      function: "permdock.authz_version_for",
    });
    expect(
      authorizationProvider({
        manifest: { ...supabaseHookManifestFixture, authzVersion: false },
      }),
    ).not.toHaveProperty("versions");
  });

  it("sets wildcards to none when no catalog key holds a wildcard", () => {
    expect(
      authorizationProvider({
        manifest: supabaseHookManifestFixture,
        catalog: catalog(["post.read"]),
      }).wildcards,
    ).toBe("none");
    expect(
      authorizationProvider({ manifest: supabaseHookManifestFixture }),
    ).not.toHaveProperty("wildcards");
  });
});

describe("doctor", () => {
  it("names permdock doctor --json and passes timeoutMs through", () => {
    expect(
      authorizationProvider({ manifest: supabaseHookManifestFixture }).doctor,
    ).toStrictEqual({
      command: ["permdock", "doctor", "--format", "findings"],
    });
    expect(
      authorizationProvider({
        manifest: supabaseHookManifestFixture,
        doctor: { timeoutMs: 120_000 },
      }).doctor,
    ).toStrictEqual({
      command: ["permdock", "doctor", "--format", "findings"],
      timeoutMs: 120_000,
    });
  });

  it("reports a timeoutMs that is not a positive whole number", () => {
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      doctor: { timeoutMs: -1 },
    });
    expect(provider.doctor).toStrictEqual({
      command: ["permdock", "doctor", "--format", "findings"],
    });
    expect(provider.problems).toContainEqual(
      "doctor.timeoutMs is -1; pass a positive whole number of milliseconds.",
    );
  });
});
