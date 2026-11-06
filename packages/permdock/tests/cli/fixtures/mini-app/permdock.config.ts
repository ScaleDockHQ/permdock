export default {
  permissions: "./src/permissions.ts",
  policy: "./src/policy.ts",
  rls: { actions: { publish: "none", archive: "none" } },
  collect: { srcPath: ["./src"] },
  catalog: { out: "./permissions.catalog.json" },
};
