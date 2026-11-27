export default {
  permissions: "./policy.ts",
  policy: "./policy.ts",
  rls: {
    dialect: "supabase",
    scopeTypes: { organization: "uuid" },
    authorize: "database",
    memo: "permdock",
    helpersOnly: true,
    rowHelpers: ["fileDrive", "fileNode"],
    tables: {
      file: "file_nodes",
      fileDrive: "file_drives",
      fileNode: "file_nodes",
    },
    memberships: {
      scopes: {
        organization: {
          table: "organization_users",
          columns: { organization: "organization_id" },
          user: "user_id",
          role: "role",
        },
      },
    },
  },
};
