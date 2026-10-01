---
'permdock': patch
---

CLI fixes found by the coverage suite:

- The generated barrel imports the permissions module relative to its own folder; before, the default `src/permissions.generated.ts` imported `./src/permissions.js`, which does not resolve.
- `collect`, `usage` and `doctor` skip a broken symlink in a source folder instead of crashing.
- `permdock usage` exits `2` with "policy export is not a Policy" when the policy module exports something else, instead of throwing (which crashed `doctor` at PD003).
- A computed identifier key such as `defineRoles({ [name]: … })` no longer counts as a role named `name`, which made `usage` report a false "granted by no role".
- PD009 names the duplicate `permdock` package folders, not their parent `node_modules`.
