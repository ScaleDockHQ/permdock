---
"permdock": minor
---

Grants take `group`, a stable name for their condition group in generated SQL: `allow(permissions.quote.read, { where: { status: 'sent' }, group: 'sent' })` gives the grant key `quote.read#sent` instead of a positional `quote.read#2`, so hand-written SQL that repeats the condition keeps working when other grants are added, removed or reordered. Unnamed groups keep their positional keys. `rls generate` refuses one name on two conditions of a permission and two names on one condition, and `definePolicy` refuses a name that is not lower case letters, digits, `_` and `-` starting with a letter, or is `break-glass`. The option is ignored in process. Without it nothing changes.
