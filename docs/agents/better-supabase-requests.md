# better-supabase requests

Requests for the better-supabase repository that a PermDock change waits on. Each entry is written to be pasted as an agent prompt in that repository.

## BS428 and BS429 read the policies the database stores

Needs: nothing from PermDock. Found by `node scripts/centrakit-dry-run.ts --stack` on the CentraKit copy with better-supabase 0.85.0: BS428 reports `its select policies check []` for all 28 `tenant` tables, though `pg_policies.qual` holds `permdock.permitted_organization_ids_by_permission('asset.read'::text)`.

```text
Doctor BS428 (table-shares.ts) and anything else that calls providerCalls() match the provider's `idsWith` template against `pg_policies.qual`. Postgres stores a text literal passed to a text parameter as `'asset.read'::text`, so `templatePattern` for `permdock.permitted_{scope}_ids_by_permission({permission})` never matches a live policy: after `'asset.read'` the pattern expects `)`, and finds `::text`.

Fix providerCalls so `{permission}` accepts an optional `::text` (also `::pg_catalog.text` and `::character varying`) after the closing quote, and a doubled-paren form `(('asset.read'::text))`. Add a test that introspects a policy created as `using (organization_id in (select permdock.permitted_organization_ids_by_permission('asset.read')))` through pg_policies and expects checked = [asset.read].

Doctor BS428 then reports no `tenant` table of CentraKit: with the cast removed, all 28 match their `permissions`.
```

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

0.87.0 shipped the key half of this as `permissionFilters: { keyArgument: number }`. It checks that the argument is a string literal and does not check a tenant argument. The tenant half, and a `text[]` key, are the next request.

## BS430 checks a tenant argument on a permission filter

Needs: `permdock` 0.34 `rls.permissionFilters`.

```text
AuthorizationPermissionFilter is `{ keyArgument: number }`. BS430 (`literal()` in function-shares) accepts the call when that argument is a string const and adds the key to the share key. It never checks a tenant argument, so listing `permdock_tenant_has(p_grant, p_tenant)` would let a caller pass another tenant and share the result. `literal()` also reads only a string const, so `permitted_tenant_permission_keys_active(array['orders.read'])` fails with "isn't a string literal".

PermDock 0.34 therefore emits one-argument wrappers that read the tenant from the token, `permdock_<root>_has_active(p_grant text)` and `permitted_<root>_permission_keys_active(p_keys text[])`, and lists only those. The `has_active` call with a string literal passes BS430. The keys call does not, until a `text[]` literal is accepted.

Add `tenantArgument?: number` to AuthorizationPermissionFilter, checked the same way the 0.31 `tenantHelpers` request checks a tenant argument: the argument is the function's own tenant parameter or the tenant the fill passes. A literal, a column, a subquery or any other expression fails, and the message names the argument.

Also accept a `text[]` literal at `keyArgument` when every element is a string literal and every element is in the entry's `permissions`. Add each element to the share key.

Tests. `select permdock.permdock_tenant_has('orders.read', p_tenant)` passes when `keyArgument` is 0 and `tenantArgument` is 1; the same call with another tenant or a non-literal key fails. `select permdock.permitted_tenant_permission_keys_active(array['orders.read'])` passes and adds `orders.read` to the share key; an array that holds a non-literal or a key outside `permissions` fails.

Docs. Describe `tenantArgument` next to `keyArgument`.
```

## An "authorization" warm step from `warm(bsb)`

Needs: `permdock` 0.31 `authorizer(...).warm()` and `authorizationHooks(...).warm()`.

```text
`warm(bsb)` (the instrumentation.ts helper) warms the database, the version cache and the JWKS, but not the authorizer, so the first request builds PermDock's instance: 1.95 ms against 1.17 ms warmed on the CentraKit fixture (`scripts/centrakit-latency.json`, `firstRequest`).

Add an "authorization" step to warm(bsb). The `authorizer` and `authorizationHooks` server options may carry `warm?(): Promise<{ ok: boolean; ms: number }>`; PermDock 0.31 provides it on both objects. The step:
1. Calls `warm()` on the configured authorizer and on the hooks, in parallel, once per process.
2. Treats a missing `warm` as a skipped step, and `ok: false` or a rejection as a failed step that is reported and never thrown, because the first request builds the instance itself.
3. Reports `{ step: "authorization", ok, ms }` next to the other steps, and runs after the policy module is imported.

Contract. Add `warm?` to the Authorizer and AuthorizationHooks types with the signature above; do not change `evaluate`, `evaluations` or any hook.

Tests. A stub authorizer with `warm` is called once per `warm(bsb)`; one without `warm` is skipped; one whose `warm` rejects reports a failed step and `warm(bsb)` still resolves.

Docs. Add the step to the warm(bsb) page with the instrumentation.ts line.
```
