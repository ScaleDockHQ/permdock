# Blocks, presets and the catalog

Read this when the user asks which blocks exist, which block fits a feature, or
what a preset installs.

## Find a block

`BLOCK_CATALOG` from `better-supabase/preset` lists every block with its
`title`, `category`, `description`, `requires`, `integrates`, `modes`, `events`,
`subpath` and docs link. It is generated from the block manifests, so it is
never out of date for the installed version.

```ts
import { BLOCK_CATALOG } from "better-supabase/preset";

const care = BLOCK_CATALOG.blocks.filter((block) => block.category === "care");
```

`PRESET_CATALOG` holds the same blocks with their SQL modules, for tooling that
resolves a preset. Do not copy block lists into an app or a prompt; read the
catalog.

Without running code, read [catalog-index.md](catalog-index.md): it lists the
block categories, the named presets and the glossary, and links to one file per
category with each block's client, entities, permission keys, events and ports.

## Install blocks

Run `pnpm better-supabase add <block>`. It installs what the block requires and
prints a numbered checklist to follow. The block's docs page is
`https://bettersupabase.com/docs/blocks/<name>`.

## Presets

A named preset is a set of blocks plus conventions. `init` and the Create page
start from one. Presets that cover business domains include `psa` (clients,
tasks, billable time from rate cards, shifts, expenses, quotes, contracts and
invoices), `ats` (recruiting) and `intranet`, next to `erp`, `care`, `cms`,
`qms`, `isms` and `ai-agents`.

```ts
import {
  namedPreset,
  presetConfig,
  resolvePreset,
} from "better-supabase/preset";

const resolved = resolvePreset(namedPreset("psa"));

resolved.blocks; // every block to install, with the reason
resolved.conflicts; // blocks that can't install under the preset's conventions
const blocks = presetConfig(resolved).blocks; // the `blocks` key of the config
```

A preset only adds blocks over time. Check `resolved.conflicts` before you
write the config: a block can need tenants or another convention the preset
doesn't have.

`apps/examples/blocks` in the repository runs each of these in tests.
