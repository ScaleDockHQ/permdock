---
"permdock": patch
---

`rls.apiKeys` holds a user key whose claim names a `tenant` to that tenant. The generated `permitted_<scope>_ids` and `member_<scope>_ids` keep only the key's tenant and the instances inside it, whatever `rls.tenants` says, so with `rls.tenants: 'all'` a user in two tenants whose key names one reads only that one. A scope `memberOf` check compares its tenant column with the key's tenant, a scope outside the first scope's chain admits nothing for such a key, and `permdock_has` returns false for it, since a global role reaches every tenant. A key without a `tenant`, a tenant service key and the `_for` helpers are unchanged.
