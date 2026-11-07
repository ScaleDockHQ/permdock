import { allow, definePolicy, relation, role } from "permdock";

import { permissions } from "./permissions.ts";

const { doc, employee, folder, item, message, thread } = permissions;

const viewer = relation(folder, "viewer", { through: "parent", depth: 4 });

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [
    role(
      "member",
      [allow(item.read), allow(thread.read), allow(message.read)],
      { on: "tenant", assignable: true },
    ),
    role(
      "admin",
      [
        allow(item.read),
        allow(item.update),
        allow(thread.read),
        allow(message.read),
      ],
      { on: "tenant", assignable: true },
    ),
  ],
  grants: [
    allow(doc.read, { to: relation(doc, "owner") }),
    allow(doc.read, { to: viewer }),
    allow(doc.update, {
      to: relation(folder, "editor", { through: "parent", depth: 2 }),
    }),
    allow(folder.read, { to: viewer }),
    allow(folder.read, {
      to: relation(folder, "owner", { through: "parent", depth: 4 }),
    }),
    allow(folder.update, { to: relation(folder, "editor") }),
    allow(employee.read, {
      to: relation(employee, "manager", { through: "parent", depth: 3 }),
    }),
  ],
});
