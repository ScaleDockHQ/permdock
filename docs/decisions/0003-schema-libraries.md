# 0003. Zod, ArkType and agent SDKs where PermDock supports them

- Status: accepted
- Date: 2026-09-30

## Context

The standard uses Valibot and bans Zod through `no-restricted-imports`. PermDock accepts any Standard Schema, and its adapters wrap the MCP, AI SDK, Claude Agent and OpenAI Agents SDKs, whose tool definitions take Zod schemas.

## Decision

- `packages/permdock`, `tests` and `apps/examples` may import Zod, ArkType and the agent SDKs, to test and demonstrate each supported schema library.
- `apps/marketing` keeps `zod` only as the optional Zod 4 peer of `fumadocs-core`. The `shadcn` CLI depends on Zod 3, which would otherwise satisfy that peer with the wrong major.
- `apps/docs` keeps `zod` only as the required peer of `ai`. The docs code never imports it: the Ask AI tool schemas use `jsonSchema()` with Valibot validation.
- Everywhere else the lint ban applies.

## Consequences

The app bundles carry no Zod code of their own. Revisit when `ai` and `fumadocs-core` drop the Zod peer.

## Alternatives considered

- Valibot only, converting to Zod inside each adapter: the agent SDKs type tool inputs as Zod, so the conversion would show up in every example.
- Leaving the `ai` and `fumadocs-core` Zod peers unmet: `strictPeerDependencies` fails the install.
