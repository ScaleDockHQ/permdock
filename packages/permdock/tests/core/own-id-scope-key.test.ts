import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { createPermDock, fromSnapshot } from "../../src/core/permdock.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

/** The organizations table is the tenant itself: its own `id` is the organization id. */
const permissions = definePermissions({
  organization: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { self: { field: "id", memberOf: "organization" } },
  }),
  project: resource({
    id: "id",
    actions: ["read"],
    relations: {
      org: { field: "organization_id", memberOf: "organization" },
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  roles: [
    role(
      "admin",
      [
        allow([
          permissions.organization.read,
          permissions.organization.update,
          permissions.project.read,
        ]),
      ],
      { on: "organization" },
    ),
  ],
  subject: () => null,
});

const admin = {
  principal: {
    id: "u1",
    tenant: "T",
    memberships: [{ scope: "organization", id: "T", roles: ["admin"] }],
  },
  context: {},
};

describe("a resource whose own id is the scope instance", () => {
  it("checks the row's id against the membership in process and in a snapshot", async () => {
    const permdock = await createPermDock(policy, admin);
    expect(permdock.can(permissions.organization.update, { id: "T" })).toBe(
      true,
    );
    expect(permdock.can(permissions.organization.update, { id: "X" })).toBe(
      false,
    );
    expect(
      permdock.can(permissions.project.read, {
        id: "p",
        organization_id: "T",
      }),
    ).toBe(true);
    expect(permdock.where(permissions.organization.read).condition).toEqual({
      op: "eq",
      field: "id",
      value: "T",
    });
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected an unsigned snapshot");
    }
    expect(snapshot.scopes).toEqual([
      {
        name: "organization",
        key: "organization_id",
        resources: ["organization", "project"],
        fields: { organization: "id" },
      },
    ]);
    const local = fromSnapshot(snapshot);
    expect(local.can(permissions.organization.update, { id: "T" })).toBe(true);
    expect(local.can(permissions.organization.update, { id: "X" })).toBe(false);
  });

  it("compiles the role check on the id column", () => {
    const ctx: RlsSqlContext = {
      dialect: "supabase",
      tenantClaim: "tenant_id",
      scopes: scopeList(policy.scopes),
      gucPrefix: "app",
    };
    const compiled = compileGrants(policy, ctx, undefined, [], false);
    const text = JSON.stringify(compiled.branches);
    expect(text).toContain(
      String.raw`\"id\" in (select \"permdock\".permitted_organization_ids('organization.update'))`,
    );
    expect(text).toContain(
      String.raw`\"organization_id\" in (select \"permdock\".permitted_organization_ids('project.read'))`,
    );
  });

  it("refuses several memberOf relations to the scope when none is its key", () => {
    const twice = definePermissions({
      transfer: resource({
        id: "id",
        actions: ["read"],
        relations: {
          from: { field: "from_org", memberOf: "organization" },
          to: { field: "to_org", memberOf: "organization" },
        },
      }),
    });
    expect(() =>
      definePolicy(twice, {
        scopes: { organization: { key: "organization_id" } },
        roles: [
          role("admin", [allow(twice.transfer.read)], { on: "organization" }),
        ],
        subject: () => null,
      }),
    ).toThrow(/several memberOf relations to 'organization'/u);
  });
});
