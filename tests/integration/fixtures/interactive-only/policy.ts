import {
  allow,
  definePermissions,
  definePolicy,
  relation,
  resource,
  role,
} from "permdock";

export const permissions = definePermissions({
  organization: resource({
    id: "id",
    actions: {
      read: {},
      update: {},
      transferOwnership: { interactiveOnly: true },
    },
    relations: { self: { field: "id", memberOf: "tenant" } },
  }),
  doc: resource({
    id: "id",
    actions: { read: {}, purge: { interactiveOnly: true } },
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      owner: "ownerId",
    },
  }),
});

const { organization, doc } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role(
      "owner",
      [
        allow([
          organization.read,
          organization.update,
          organization.transferOwnership,
          doc.read,
        ]),
      ],
      { on: "tenant", transferOnly: true, assigns: ["owner", "member"] },
    ),
    role("member", [allow([organization.read, doc.read])], {
      on: "tenant",
      assignable: true,
    }),
  ],
  grants: [allow(doc.purge, { to: relation(doc, "owner") })],
  subject: () => null,
});
