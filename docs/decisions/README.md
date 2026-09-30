# Decision records

Each file records one place where this repository differs from the ScaleDockHQ repo standard, and why. Product and API design decisions do not go here: they live in the `Why` section of the owning page in `apps/docs/content/docs`.

Copy `0000-template.md`, take the next number, and add a row below. When a decision changes, set its status to superseded and add a new record.

| Record | Decision |
| --- | --- |
| [0001](./0001-skills-in-agents-folder.md) | Vendored skills stay in `.agents/skills` |
| [0002](./0002-no-typescript-catalog-override.md) | No global `typescript` override |
| [0003](./0003-schema-libraries.md) | Zod, ArkType and agent SDKs where PermDock supports them |
| [0004](./0004-node-engines.md) | `permdock` keeps `engines.node: ">=24"` |
| [0005](./0005-extra-workspaces-and-scripts.md) | Extra workspace globs and root scripts |
| [0006](./0006-vendored-ui-tsconfig.md) | Relaxed tsconfig for vendored UI code |
| [0007](./0007-permdock-tests-not-type-checked.md) | `packages/permdock/tests` is not type-checked yet |
| [0008](./0008-turbo-query-affected.md) | `turbo query affected` instead of `turbo-ignore` |
| [0009](./0009-boundaries-limits.md) | Boundary rules Turborepo cannot express |
| [0010](./0010-vercel-corepack-bootstrap.md) | `vercel.json` bootstraps pnpm through Corepack |
| [0011](./0011-docs-robots.md) | The docs app has no `robots.ts` |
| [0012](./0012-cross-zone-links.md) | Cross-zone links are plain anchors |
| [0013](./0013-no-fumadocs-openapi.md) | No `fumadocs-openapi` pages |
| [0014](./0014-no-fumadocs-twoslash.md) | No `fumadocs-twoslash` |
| [0015](./0015-ask-ai-input.md) | Ask AI input built from `InputGroup` |
| [0016](./0016-portless-names.md) | Portless names under `permdock.localhost` |
