import { describe, expect, it } from "vitest";
import { z } from "zod";

import { resolveNames } from "../../src/cli/sql/resolve-names.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
  role,
} from "../../src/index.ts";

const id = z.uuid();

const permissions = definePermissions({
  doc: resource(z.object({ id, folderId: id, orgId: id }), {
    actions: ["read"],
    parent: { field: "folderId", resource: "folder" },
  }),
  folder: resource(z.object({ id, orgId: id }), {
    actions: ["read"],
    relations: { viewer: { edge: "folder_viewers" } },
  }),
});

const grants = [
  allow(permissions.doc.read, {
    to: relation(permissions.folder, "viewer", { through: "parent" }),
  }),
];

function policyWith(scopes: Record<string, { key: string; within?: string }>) {
  return definePolicy(permissions, {
    scopes,
    roles: [role("member", [allow(permissions.folder.read)])],
    grants,
    subject: () => null,
  });
}

describe(resolveNames, () => {
  it("names every scope and graph resource helper, frozen", () => {
    const names = resolveNames(
      policyWith({
        organization: { key: "orgId" },
        team: { key: "teamId", within: "organization" },
      }),
      {
        rls: {
          tables: { doc: "public.docs" },
          rowHelpers: ["doc"],
          fields: "views",
        },
      },
    );
    expect(names).toStrictEqual({
      schema: "permdock",
      gucPrefix: "app",
      claims: { tenant: "tenant_id", role: "user_role" },
      teamScope: "team",
      scopes: {
        organization: {
          permittedIds: "permitted_organization_ids",
          permittedIdsFor: "permitted_organization_ids_for",
          memberIds: "member_organization_ids",
          memberIdsFor: "member_organization_ids_for",
          permittedUsers: "permitted_organization_users",
        },
        team: {
          permittedIds: "permitted_team_ids",
          permittedIdsFor: "permitted_team_ids_for",
          memberIds: "member_team_ids",
          memberIdsFor: "member_team_ids_for",
          memberIdsOf: "member_team_ids_of",
          permittedUsers: "permitted_team_users",
        },
      },
      resources: {
        doc: {
          table: "public.docs",
          rows: "permitted_doc_rows",
          row: "permitted_doc_row",
          visible: "public.docs_visible",
          visibleFields: "docs_visible_fields",
          mask: "docs_mask",
        },
        folder: {
          permittedIds: "permitted_folder_ids",
          restricted: "permdock_restricted_folder",
        },
      },
    });
    expect(Object.isFrozen(names.scopes["team"])).toBe(true);
  });

  it("follows the schema, GUC prefix and claim settings", () => {
    const names = resolveNames(policyWith({ organization: { key: "orgId" } }), {
      rls: {
        schema: "authz",
        gucPrefix: "myapp",
        tenantClaim: "org",
        roleClaim: "r",
      },
    });
    expect([names.schema, names.gucPrefix, names.claims]).toStrictEqual([
      "authz",
      "myapp",
      { tenant: "org", role: "r" },
    ]);
    expect(names.teamScope).toBeUndefined();
  });

  it("rejects a scope and a resource that share a helper", () => {
    expect(() =>
      resolveNames(policyWith({ folder: { key: "orgId" } }), {}),
    ).toThrow(
      "PermDock CLI: scope 'folder' and resource 'folder' both name the SQL helper 'permitted_folder_ids'; rename one of them",
    );
  });

  it("rejects a helper longer than Postgres keeps", () => {
    const long = "a".repeat(47);
    expect(() =>
      resolveNames(policyWith({ [long]: { key: "orgId" } }), {}),
    ).toThrow(
      `PermDock CLI: scope '${long}' names the SQL helper 'permitted_${long}_ids_for', longer than the 63 bytes Postgres keeps; shorten the name`,
    );
  });
});
