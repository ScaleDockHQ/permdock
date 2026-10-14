import { solidStart } from "@solidjs/start/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    solidStart({
      // SolidStart joins `appRoot` to the process cwd, which is the repository root under Knip.
      appRoot: path.relative(
        process.cwd(),
        fileURLToPath(new URL("src", import.meta.url)),
      ),
      middleware: "./src/middleware.ts",
    }),
  ],
});
