---
'permdock': patch
---

The `permdock` CLI starts faster and reports failures in a form scripts can read.

- `permdock --version` (`-v`) prints the version. `--help` prints a static command list and loads no command, no config and no core.
- `--yes` (`-y`) never prompts and takes the answer the flags give.
- Under `--json`, a failure prints RFC 9457 Problem Details on stdout, with `type` `https://permdock.dev/problems/cli-usage` or `cli-unavailable`.
- A database that does not answer exits with `1`, not `2`, and names the command. `--db` connections time out after 10 seconds and statements after 60. `rls introspect` runs its queries in parallel over a pool of four. Ctrl-C ends the connection and exits with `130`.
- Generated SQL, catalogs and `who-can` output sort by code unit, so the same input gives the same bytes in every locale and runtime.
