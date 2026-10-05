---
"permdock": minor
---

`rls generate --helpers-only` combines with `--fields views` (`rls.helpersOnly` with `rls.fields: 'views'`): it writes the field views next to the helpers, so a role at one scope whose grants list `fields` (a portal contact) reads masked columns through `<table>_visible` while the row policies stay hand-written. `--revoke-columns` is still refused with `--helpers-only`, because the table grants are the application's. Before, `--helpers-only` refused `--fields`, and an application with hand-written policies needed security definer functions to return field-safe rows per scope.
