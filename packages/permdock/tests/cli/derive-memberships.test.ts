import { describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd121 } from "../../src/cli/doctor/membership-facts.ts";
import {
  membershipsFromSources,
  restatedFacts,
  withSourcedRls,
} from "../../src/cli/sql/derive-memberships.ts";
import {
  junctionMembershipSource,
  tableMembershipSource,
} from "../../src/supabase/index.ts";

const through = { through: "roles", on: { role_id: "id" }, column: "key" };

const suspension = {
  users: { table: "profiles", id: "user_id", disabledAt: "disabled_at" },
};

const hook = {
  memberships: [
    junctionMembershipSource({
      table: "organization_users",
      scope: "organization",
      roles: through,
      expiresAt: "expires_at",
    }),
  ],
  suspension,
};

const table = {
  table: "public.organization_users",
  user: "user_id",
  role: { ...through, through: "public.roles" },
  columns: { organization: "organization_id" },
  expiresAt: "expires_at",
};

describe(membershipsFromSources, () => {
  it("describes a junction source as an rls.memberships table", () => {
    expect(membershipsFromSources({ supabase: { hook } })).toStrictEqual({
      scopes: { organization: table },
    });
  });

  it("leaves out a source the table form cannot describe", () => {
    expect(
      membershipsFromSources({
        supabase: {
          hook: {
            memberships: [
              tableMembershipSource({ table: "memberships" }),
              junctionMembershipSource({
                table: "contacts",
                scope: "organization",
                roles: ["contact"],
              }),
            ],
          },
        },
      }),
    ).toBeUndefined();
  });

  it("derives nothing when one source of several cannot be described", () => {
    expect(
      membershipsFromSources({
        rls: {
          membershipSources: [
            ...hook.memberships,
            tableMembershipSource({
              table: "account_users",
              columns: {
                role: { column: "kind", map: { admin: "owner", user: null } },
              },
            }),
          ],
        },
      }),
    ).toBeUndefined();
  });
});

describe(withSourcedRls, () => {
  it("fills rls.memberships and rls.suspension from the sources", () => {
    const config = withSourcedRls({ rls: {}, supabase: { hook } });
    expect(config.rls?.memberships).toStrictEqual({
      scopes: { organization: table },
    });
    expect(config.rls?.suspension).toStrictEqual(suspension);
  });

  it("keeps what rls writes and leaves a config without rls alone", () => {
    const written = { scopes: { organization: { ...table, user: "member" } } };
    expect(
      withSourcedRls({ rls: { memberships: written }, supabase: { hook } }).rls
        ?.memberships,
    ).toBe(written);
    const bare: PermDockConfig = { supabase: { hook } };
    expect(withSourcedRls(bare)).toBe(bare);
  });
});

describe("PD121", () => {
  it("reports a written table that differs from its source", () => {
    expect(
      pd121({
        rls: {
          memberships: {
            scopes: { organization: { ...table, user: "member_id" } },
          },
        },
        supabase: { hook },
      }),
    ).toStrictEqual([
      expect.objectContaining({
        code: "PD121",
        target: "rls.memberships.scopes.organization",
        message: expect.stringContaining("differently"),
      }),
    ]);
  });

  it("reports a restated table and suspension, which the prune removes", () => {
    const config: PermDockConfig = {
      rls: {
        memberships: {
          scopes: {
            organization: {
              ...table,
              table: "organization_users",
              role: through,
            },
          },
        },
        suspension,
      },
      supabase: { hook },
    };
    expect(restatedFacts(config)).toStrictEqual([
      ["rls", "memberships", "scopes", "organization"],
      ["rls", "suspension"],
    ]);
    expect(pd121(config).map((finding) => finding.target)).toStrictEqual([
      "rls.memberships.scopes.organization",
      "rls.suspension",
    ]);
  });
});
