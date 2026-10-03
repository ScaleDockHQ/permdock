# `@permdock/example-terminal`

Minimal CLI wiring for `permdock/terminal`: env / keychain subject resolution, `filterCommands` help, `protect` on `status` / `deploy` / `rollback`, `--json` Problem Details, `--dry-run`, a destructive `rollback` that needs a typed confirmation or `--yes`, and an agent-run actor from `PERMDOCK_ACTOR_TOKEN`.

```ts
import { createPermDock } from "permdock/terminal";
```

```bash
PERMDOCK_TOKEN=dev pnpm start -- --help
PERMDOCK_TOKEN=dev pnpm start -- deploy --env staging
PERMDOCK_TOKEN=release pnpm start -- deploy --env production --json
PERMDOCK_TOKEN=dev pnpm start -- deploy --dry-run
PERMDOCK_TOKEN=dev pnpm start -- rollback --yes
```
