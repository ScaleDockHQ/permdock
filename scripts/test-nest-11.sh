#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

sed -i.bak -E 's#^(  "@nestjs/(common|core|platform-express|platform-fastify)": ).*#\1"11.2.7"#' pnpm-workspace.yaml
rm pnpm-workspace.yaml.bak

pnpm install --no-frozen-lockfile
pnpm exec turbo run build --filter=permdock
pnpm --filter permdock exec vitest run tests/nest
pnpm --filter @permdock/integration exec vitest run src/http/nest.test.ts
