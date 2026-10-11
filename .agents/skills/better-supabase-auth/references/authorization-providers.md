# Authorization providers

An authorization provider is a plain object in the `authorization` key of
`better-supabase.config.ts`. The authorization package builds it; you don't
write it by hand. It names the SQL functions that answer permission checks,
the scopes, the permission keys those functions answer completely, the
membership tables and the access token hook the provider generates.

```ts
export default defineConfig({
  authorization: authorizationProvider(), // from the authorization package
  sql: { modules: { access: { model: "provider" } } },
});
```

## Rules

- When `authorization.tokenHook.ownedClaims` has `memberships`, the
  provider's hook owns the memberships and the tenant claim. Don't run
  `better-supabase sql add tenant` (it stops without `--force`), don't call
  `membership_claims()` from a hook, and don't write the claims in
  `ownedClaims` yourself. Doctor reports BS407 when a hook does.
- `sql add entitlements` is fine. With a provider it reads memberships through
  the provider's `memberIds` and `memberIdsFor` (`entitlements.memberships`
  defaults to `"provider"`). For `hasEntitlement(session, ...)`, the
  provider's hook must fill `features` from `better_supabase.feature_claims`;
  doctor reports BS408 otherwise.
- Name the same tenant claim on both sides: `claims.tenant` must equal
  `authorization.tokenHook.tenantClaim` (BS409).
- `sql.modules.access.model: "provider"` makes `can()`, `tenant_ids_with()`
  and `platform_can()` call the provider's `idsWith` and `isPlatform`. Every
  permission key a SQL module checks must be `sqlComplete: true` in
  `authorization.permissions`; map an action to another key with
  `sql.modules.<module>.permissions`. Doctor reports BS411.
- Bucket and topic `access` policies call the access contract by default.
  For another scope, copy the provider's `idsWith` and `isPlatform` into the
  policy's `sql`. Use only keys marked `sqlComplete: true`: the policies check
  role and scope, never row conditions. `gen` refuses other keys and doctor
  reports BS214.
- A scope id in a path or topic is compared as text, so the segment must be
  the id's lowercase form.
- For API keys, pass `claim: { name, tenant?, roles?, scopes?, serviceRoles? }`
  to `apiKeyResolver` or `apiKeyClaims` so the request carries the claim the
  provider's functions read.
- In MCP servers, put the permission in each tool's `meta`, narrow it in
  `authorize` and `visible`, and treat a tool without one as hidden and
  refused.
- Doctor `--as <user id>` measures the claims in `tokenHook.budget` against
  its byte budget (BS405).

Docs: https://bettersupabase.com/docs/extending/authorization-providers.md
