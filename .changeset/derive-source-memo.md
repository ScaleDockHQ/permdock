---
"permdock": patch
---

`permdock.derive({ customRoles })` reads the new source with the instance's `SourceMemo`, and `customRoleSource` passes each read's `context` to its reader. An override that replaces one tenant's roles and passes `context` on to the original source no longer reads the custom-role version of every other tenant again.
