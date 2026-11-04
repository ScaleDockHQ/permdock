import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
  role,
} from "permdock";

/** Ten organisation-scoped tables and one table whose policy calls a row helper. */
export const permissions = definePermissions({
  t01: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t02: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t03: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t04: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t05: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t06: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t07: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t08: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t09: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  t10: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "tenant" } },
  }),
  doc: resource({
    id: "id",
    actions: ["read"],
    relations: {
      org: { field: "organization_id", memberOf: "tenant" },
      owner: "owner_id",
    },
  }),
});

const { t01, t02, t03, t04, t05, t06, t07, t08, t09, t10, doc } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "organization_id" } },
  roles: [
    role(
      "member",
      [allow([t01, t02, t03, t04, t05, t06, t07, t08, t09, t10, doc.read])],
      { on: "tenant", assignable: true },
    ),
  ],
  grants: [allow(doc.read, { to: relation(doc, "owner") })],
  subject: () => null,
});
