import { allow, definePolicy, principal, role, sqlFunction } from "permdock";

import { permissions, roles } from "./permissions.ts";

export type User = { readonly id: string; readonly roles: readonly string[] };

export const policy = definePolicy(
  { permissions, roles },
  {
    roles: [
      role(roles.member, [
        allow(permissions.file.read, {
          where: sqlFunction("file_ids_for", {
            args: ["read"],
            set: { column: "id" },
            twin: { ownerId: principal.id },
          }),
        }),
      ]),
    ],
    subject: (user: User | null) => user,
  },
);
