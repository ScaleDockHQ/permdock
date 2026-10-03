import { defineConfig } from "permdock/cli";

export default defineConfig({
  permissions: "../../packages/permissions/src/index.ts",
  collect: {
    srcPath: ["./src"],
    out:
      process.env["PERMDOCK_E2E_DRIFT"] === "1"
        ? "./drifted.catalog.json"
        : "./permissions.catalog.json",
  },
});
