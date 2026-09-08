# `@permdock/cli`

Developer tooling for PermDock. The binary is `permdock`.

```bash
pnpm add -D @permdock/cli
pnpm exec permdock collect --check
pnpm exec permdock usage --strict
pnpm exec permdock doctor
pnpm exec permdock skills install
```

`createPermDockPlugin` is re-exported from `permdock/next/plugin`. `createPermDockUnplugin` lives at `@permdock/cli/unplugin`. Both run collect only and never wire runtime API.

See [the CLI docs](https://permdock.dev/docs/cli).
