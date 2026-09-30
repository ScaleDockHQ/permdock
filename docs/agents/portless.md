# Portless

`pnpm dev:portless` runs marketing at `https://permdock.localhost` and docs at `https://docs.permdock.localhost`. Marketing proxies `/docs`, `/mcp`, `/llms.txt` and the other docs routes, so `https://permdock.localhost/docs` is the URL to check. In a git worktree, Portless prefixes the branch: `https://<branch>.permdock.localhost`.

- Check for a running server before starting one: `pnpm exec portless list`. Reuse a PermDock route if it is there.
- The proxy is shared by every repository on the machine. Never run `portless proxy stop`, `portless clean` or `portless prune`, and never kill a process you did not start. Routes from other projects, such as `app.localhost` or `api.localhost`, belong to other repositories.
- Stop only the process tree you started, then confirm with `portless list` that its routes are gone.
- If the proxy is not running, Portless needs a terminal to ask for `sudo` on port 443. Ask the user to run `pnpm exec portless proxy start` once. Do not work around it with another port.
- Names live in each app's `package.json` `portless` key. `portless.json` is read only from the current directory, so a root file does not reach `turbo run dev:portless`.
- Next.js reads the `PORT` Portless assigns. A `dev` script that hard-codes `-p` returns 502 through the proxy: use `-p ${PORT:-3001}`.
- `allowedDevOrigins` needs `**.localhost`: in Next.js, `*` matches exactly one label.
- `pnpm dev` runs without Portless: marketing on `:3000`, docs on `:3001`.
- `pnpm dev:cleanup` runs `portless prune`, which kills orphaned dev servers. Run it only when the user asks.
