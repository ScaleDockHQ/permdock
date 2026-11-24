# better-supabase requests

Requests for the better-supabase repository that a PermDock change waits on. Each entry is written to be pasted as an agent prompt in that repository.

## BS430 accepts a call to a tenant-pure helper

Needs: `permdock` 0.31 `rls.tenantPureHelpers`.

```text
Doctor BS430 refuses every call from a sharedFunctions entry to a function in the read schemas that the entry does not list. An authorization provider can now declare helpers whose answer depends only on the caller's grants of one key in one tenant. Accept a call to such a helper and add its key to the share key.

Contract. Add `tenantHelpers` to AuthorizationProvider:

  readonly tenantHelpers?: Readonly<Record<string, { keyArgument: string; tenantArgument: string }>>;

The record is keyed by `schema.name`. `keyArgument` and `tenantArgument` are parameter names of the helper; `keyArgument` holds a permission or grant key (`text`) or several (`text[]`); `tenantArgument` holds the tenant id. PermDock fills it from `rls.tenantPureHelpers` in permdock.manifest.json:

  permdock.permdock_tenant_has            keyArgument p_grant, tenantArgument p_tenant
  permdock.permitted_tenant_permission_keys  keyArgument p_keys,  tenantArgument p_id

Doctor BS430. In a `language sql`, `security invoker`, stable or immutable function listed in sharedFunctions, accept a call to a listed helper when both hold:
1. The tenant argument is the entry's tenant: the function's own tenant parameter or the tenant the fill passes. Any other expression, a literal, a column or a subquery fails with the argument named.
2. The key argument is a literal (or an array literal) naming only keys that the entry lists in `permissions`. A parameter, a column or an expression fails, because the share key would not cover it.
Every other call into the read schemas stays an error. A function that passes the tenant but reads the caller still fails on the existing identity rules.

Share key. Callers share an entry when their grantFingerprint over the union of the entry's `permissions` and the helper keys of the calls is equal. Add those keys to the keys passed to `shareKey` for that function, so a caller who lacks a helper key gets a different key or none.

Tests. A function with `select permdock.permdock_tenant_has('orders.read', p_tenant)` passes; the same call with another tenant, a non-literal key or an unlisted key fails; two callers with equal grants share one entry and a caller without the helper key does not.

Docs. Describe `tenantHelpers` next to `sharedFunctions` and name PermDock's two helpers.
```

Why only these two helpers: `docs/guides/shared-cache.mdx`, "Helpers that answer the same for equal grants".
