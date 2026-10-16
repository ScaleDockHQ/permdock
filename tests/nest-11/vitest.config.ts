import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const NEST = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
];

// The suites live in packages/permdock and tests/integration, whose own installs
// carry Nest 12; every `@nestjs/*` import resolves to this workspace's Nest 11.
// The built `permdock/nest` entry is outside node_modules, so Vitest inlines it
// and the alias reaches its imports too.
export default defineConfig({
  root: join(here, "..", ".."),
  resolve: {
    alias: NEST.map((name) => ({
      find: new RegExp(`^${name}$`, "u"),
      replacement: require.resolve(name),
    })),
  },
  test: {
    name: "nest-11",
    include: [
      "packages/permdock/tests/nest/**/*.test.ts",
      "tests/integration/src/http/nest.test.ts",
    ],
    testTimeout: 120_000,
  },
});
