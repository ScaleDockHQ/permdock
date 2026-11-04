import { defineConfig } from "permdock/cli";

import { permissions, policy } from "./policy.ts";

export default defineConfig({
  permissions,
  policy,
  rls: {
    dialect: "supabase",
    authorize: "database",
    scopeTypes: { tenant: "uuid" },
    tables: {
      t01: "bench_t01",
      t02: "bench_t02",
      t03: "bench_t03",
      t04: "bench_t04",
      t05: "bench_t05",
      t06: "bench_t06",
      t07: "bench_t07",
      t08: "bench_t08",
      t09: "bench_t09",
      t10: "bench_t10",
      doc: "bench_doc",
    },
    rowHelpers: ["doc"],
    memberships: {
      scopes: {
        tenant: {
          table: "bench_members",
          columns: { tenant: "organization_id" },
          user: "user_id",
          role: "role",
        },
      },
    },
  },
});
