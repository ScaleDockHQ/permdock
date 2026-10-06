---
"permdock": minor
---

`permdock skills install` follows a symlinked agent or skill folder (`.claude/skills/permdock` linked to `.agents/skills/permdock`) and writes the files once at the target, where it failed with "Cannot overwrite non-directory" before. `permdock skills install --check` compares the installed skills with the package version, writes nothing, and exits `1` listing every missing or changed file.
