import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from "permdock";

export const permissions = definePermissions({
  doc: resource({
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
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
    role("editor", [allow([doc.read, doc.update, file.read])], {
      on: "tenant",
      assignable: true,
    }),
    role("member", [allow([doc.read, file.read])], {
      on: "tenant",
      assignable: true,
    }),
    role("reader", [allow(file.read)], { on: "tenant", assignable: true }),
    role("frozen", [deny(doc.read)], { on: "tenant" }),
  ],
  // SAFETY: the test passes a Subject, which this resolver returns unchanged.
  subject: (subject: unknown) => subject as never,
});
