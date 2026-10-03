# 0016. Portless names under `permdock.localhost`

- Status: accepted
- Date: 2026-09-30

## Context

The standard names the apps `www` and `docs` in a root `portless.json`, and gives the ReUI MCP a `Bearer ${env:REUI_LICENSE_KEY}` header. The Portless proxy is shared by every repository on the machine, so bare names collide. `portless.json` is read only from the current directory, while `turbo run dev:portless` runs Portless inside each app. The ReUI MCP authenticates by browser sign-in or a personal token: a license key is rejected, and a static header overrides the sign-in.

## Decision

- Each app sets its name in its `package.json` `portless` key: `permdock` for marketing and `docs.permdock` for docs.
- Marketing sets `DOCS_ORIGIN` from `portless get docs.permdock`, so worktree prefixes carry over.
- `allowedDevOrigins` uses `**.localhost`, because `*` matches one label.
- The MCP configs register `https://mcp.reui.io` without a header.

## Consequences

The URLs are `https://permdock.localhost` and `https://docs.permdock.localhost`. `REUI_LICENSE_KEY` is used only by the shadcn CLI.

## Alternatives considered

- A root `portless.json` with `www` and `docs`: the names collide with other repositories on the shared proxy, and Portless reads the file only from the current directory.
