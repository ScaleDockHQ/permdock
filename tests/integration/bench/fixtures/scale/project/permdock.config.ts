import { supabaseRls } from "permdock/supabase";

import { permissions } from "./permissions.ts";

const { item } = permissions;

export default {
  permissions: "./permissions.ts",
  policy: "./policy.ts",
  rls: {
    ...supabaseRls({
      tenantType: "uuid",
      memberships: {
        table: "organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
      },
      storage: {
        buckets: {
          files: {
            scope: "tenant",
            read: item.read,
            write: item.update,
            delete: item.update,
          },
        },
      },
    }),
    approvals: true,
    rowHelpers: ["doc", "folder"],
    jsonSchema: false,
    idTypes: { "*": "uuid" },
    tables: {
      employee: { table: "public.employee", walk: "recursive", user: "userId" },
    },
  },
};
