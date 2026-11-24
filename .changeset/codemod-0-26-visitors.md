---
"permdock": patch
---

`permdock codemod 0.26` reads the parsed source: it removes inferred `rls.actions` entries only under a config object's `rls`, rewrites SQL helper names only in string and template literals and `.sql` files, and edits only the `tableOf` owner it read. It now rewrites `.sql` files and lists a versioned migration as a follow-up instead of editing it.
