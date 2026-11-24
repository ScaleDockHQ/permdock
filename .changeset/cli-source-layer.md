---
"permdock": minor
---

The CLI reads TypeScript and SQL through parsers. `permdock codemod` finds `defineConfig` from `permdock` through consts, `satisfies`, aliased imports and `module.exports`, and reports a value it cannot follow. Vue and Svelte `<script generic="T extends Record<string, any>">` blocks are read, doctor PD084 no longer counts `nativeRefresh` in a comment, and the SQL statement splitter handles `'a--b'`, `"a;b"`, `E'it\'s;x'` and `$a1$` bodies.
