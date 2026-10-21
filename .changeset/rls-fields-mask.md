---
"permdock": minor
---

`permdock rls generate --fields mask` (`rls.fields: 'mask'`) writes the `--fields views` output plus `<schema>.<table>_mask(p_row)` per field view: a `security invoker` function that returns the row with each restricted column the caller may not read set to `null`, so a `security definer` RPC can return what `<table>_visible` would. `--fields views` output is unchanged.
