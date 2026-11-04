import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  relation,
  resource,
  role,
} from "permdock";

export const permissions = definePermissions({
  doc: resource({
    id: "id",
    actions: ["read", "update"],
    collection: ["create"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      owner: "ownerId",
      viewer: { edge: "doc_shares", object: "doc_id", subject: "user_id" },
    },
  }),
  file: resource({
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const { doc, file } = permissions;

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow([doc.read, doc.create, file.read])], {
      on: "tenant",
      assignable: true,
    }),
    role("reader", [allow(file.read)], { on: "tenant", assignable: true }),
    role("blocked", [deny(doc.read, { where: { locked: true } })], {
      on: "tenant",
    }),
  ],
  grants: [
    allow(doc.update, { to: relation(doc, "owner") }),
    allow(doc.read, { to: relation(doc, "viewer"), requires: file.read }),
  ],
  subject: () => null,
});
