---
"permdock": minor
---

Breaking: the `permdock` CLI now uses better-supabase's problem codes, exit codes and help document. An internal error exits `1`, a missing positional exits `3` with `missing_input`, and every problem `type` links to its row on the new [CLI errors](https://permdock.com/docs/cli/errors) page. `--help --json` returns `cli-commands-v1` in the shared shape (`name`, `version`, `options`, `commands` with `path`, `effects` and `arguments`), and an agent-mode consent token is 16 hex characters bound to the reasons, the working directory and the argv.

No flag takes a secret as its value any more. `--db-url` is gone: pipe the connection string to `--db-url-stdin`, or set `DATABASE_URL` or `SUPABASE_DB_URL`, the order better-supabase reads them. `skills install --client` is `--for`. `permdock codemod 0.5` rewrites `--client` and lists each `--db-url` call site for you to change.
