# agent-browser

Use `agent-browser` to check a page after a UI, docs or routing change. The vendored skill in `.agents/skills/agent-browser` is a stub: run `agent-browser skills get core` first for the workflow that matches the installed version.

- Open the Portless URL, never a raw port: `https://permdock.localhost` for marketing, `https://permdock.localhost/docs` for docs. See [portless.md](./portless.md).
- Check a mobile (390 px) and a desktop (1440 px) viewport.
- Take a screenshot of the state you report, and show it to the user.
- A page that needs a secret the environment does not have, such as the AI Gateway for `/docs/ask`, is reported as blocked. Never add a provider key to make it work.
- `pnpm test:e2e` is the regression check. A browser session is for looking, not a replacement for a Playwright test.
