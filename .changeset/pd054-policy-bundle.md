---
"permdock": patch
---

PD054 understands `rls.staticGrants: 'ref'`. When `role_permissions` is the view over the policy bundle, the check compares the bundle hash the view pins with the hash the policy compiles to, instead of reporting every compiled row as missing.
