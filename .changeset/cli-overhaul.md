---
"permdock": minor
---

Breaking: the `permdock` CLI now shares better-supabase's CLI contract. Groups have real subcommands (`permdock openapi emit`, `permdock skills install`, `permdock arazzo check`), and flags follow one vocabulary. `permdock codemod 0.5` rewrites the old spellings in `package.json` scripts and CI workflows. Until 1.0, an old spelling exits `2` with `flag_renamed` or `command_moved` and names the new one.

| CLI before                     | CLI after                               | Commands                                                                                              |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `permdock openapi`             | `permdock openapi emit`                 |                                                                                                       |
| `permdock skills`              | `permdock skills install`               |                                                                                                       |
| `permdock arazzo`              | `permdock arazzo check`                 |                                                                                                       |
| `--db`, `--db-url`             | `--db-url-stdin` or `DATABASE_URL`      | `rls generate`, `rls import`, `rls verify`, `supabase hook generate`, `powersync verify`              |
| `--force`                      | `--force-rls`                           | `rls generate`                                                                                        |
| `--format`, `--emit`           | `--kind`                                | `rls verify`, `catalog` (`json` is `catalog`, `schema` is `json-schema`), `openapi emit`              |
| `--from`                       | `--policy`                              | `rls generate`, `rls verify`, `rls migrate`, `powersync generate`, `powersync verify`, `openapi emit` |
| `--from`                       | `--permissions`                         | `catalog`, `arazzo check`                                                                             |
| `--schema`                     | `--validator`                           | `rls import`, `openapi import`                                                                        |
| `--strict`                     | `--fail-on warning`                     | `usage`, `config`, `doctor`                                                                           |
| `--write`                      | `--scope catalog:write`                 | `login`                                                                                               |
| `--agent`, `--client`          | `--for`                                 | `skills install`, `skills update`                                                                     |
| `--src`                        | `--out-dir`                             | `init`                                                                                                |
| `--rbac-scaffold`              | `--rbac supabase`                       | `rls generate`, `rls verify`, `rls migrate`                                                           |
| `--write`, `--retire-out` only | writes by default; `--dry-run` previews | `rls migrate`                                                                                         |
| `--environment`                | `--project <id>`                        | `cloud push`                                                                                          |
| `--legacy`                     | removed                                 | `scan`                                                                                                |

`--json`, and agent mode by default, now print one `cli-result-v1` envelope for every command: the report moves into `data`, and a failure is in `error` as Problem Details with a snake_case `code`. Exit `3` means the run needs input, a login or the person's consent, and `next` lists the commands that continue it. `--help --json` prints the command tree as `cli-commands-v1`.

New: `--agent auto|yes|no` and `PERMDOCK_AGENT`; `--confirm <token>` for commands that rewrite project files, publish to the Cloud or overwrite with `--force` in agent mode; `--format github|sarif` for findings; `--debug`; `--dry-run` and `--check` on every command that writes files; `--db-url-stdin`, `--key-stdin` and `--token-stdin`; `permdock whoami`; and `permdock completion bash|zsh|fish`. The CLI no longer depends on citty.
