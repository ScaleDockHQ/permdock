import { supabaseRls } from "permdock/supabase";

import { permissions } from "../rls-matrix/permissions.ts";

const { project } = permissions;

/** A private channel and a bucket per organization: admins write, every member reads. */
export default {
  permissions: "../rls-matrix/permissions.ts",
  policy: "../rls-matrix/policy.ts",
  rls: {
    ...supabaseRls({
      tenantType: "text",
      memberships: {
        table: "organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
      },
      realtime: {
        topics: {
          "org:{tenant}:chat": { read: project.read, write: project.delete },
          // project.update also has a member grant with a row condition: only
          // the unconditional admin grant reaches the topic
          "org:{tenant}:edits": { read: project.update },
        },
      },
      storage: {
        buckets: {
          files: {
            scope: "tenant",
            read: project.read,
            write: project.delete,
            delete: project.delete,
          },
        },
      },
    }),
    readOnlyActors: true,
  },
};
