import tree from "../file-tree-scale/permdock.config.ts";

export default {
  ...tree,
  permissions: "../file-tree-scale/policy.ts",
  policy: "../file-tree-scale/policy.ts",
  rls: { ...tree.rls, idTypes: { "*": "uuid", fileNode: "numeric" } },
};
