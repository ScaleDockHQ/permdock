---
"permdock": minor
---

`permdock keys rename <from> <to>` retires a permission key: it moves the action in the permissions module, adds `"from": "to"` to `definePermissions(..., { renamed })`, and, with custom roles stored in the database, writes a data migration that moves stored grants to the new key.
