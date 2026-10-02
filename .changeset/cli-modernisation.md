---
'permdock': patch
---

The `permdock` CLI parses flags with citty. `permdock <command> --help` (or `permdock help <command>`) prints that command's flags with their values and defaults. A flag with a fixed set of values rejects any other with exit `2` and the list it accepts, for example `catalog: Invalid value for argument: --format (xml). Expected one of: json, schema, markdown.`

Config, permissions and policy modules that Node cannot load on its own fall back to jiti, so they may use `enum`, TSX, extensionless relative imports and the `paths` aliases of the nearest `tsconfig.json`.

`--check` on `collect`, `openapi`, `rls generate` and `supabase hook generate` prints a unified diff of each stale file, cut to 40 lines.

A missing optional peer (`pg`, `pgsql-parser`, `unplugin`) fails with the install line for the package manager that ran the command, or the one whose lockfile the project has.

On a terminal, `skills install` without `--agent` asks which agents to install for, and `doctor --fix` asks before writing. In CI, in a pipe or with `--json` there is no prompt.

`doctor` reports are styled on a colour terminal; `NO_COLOR` and `--no-color` turn styling off. `supabase/config.toml` is read with a TOML parser, and the new `PD045` warning reports a file that does not parse.

The CLI's new dependencies are `citty`, `jiti`, `smol-toml`, `package-manager-detector`, `@clack/prompts` and `diff`. Runtime entries still depend on `@standard-schema/spec` only.
