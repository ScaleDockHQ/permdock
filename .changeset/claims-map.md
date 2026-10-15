---
"permdock": major
---

Every subject provider takes one `claims` option, a `ClaimsMap`, for where values live in the verified claims. Each field is a dot path or a function over the claims; a function that throws reads as absent.

| Before                                                                  | After                                                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `JwtClaimPaths` (`permdock/jwt`)                                        | `ClaimsMap` (`permdock`)                                                            |
| `subjectFromSupabase(claims, { roles: "user_role", tenant: "org_id" })` | `subjectFromSupabase(claims, { claims: { roles: "user_role", tenant: "org_id" } })` |
| `subjectFromSupabase(claims, { memberships: "m", plans: "p" })`         | `subjectFromSupabase(claims, { claims: { memberships: "m", plans: "p" } })`         |
| `subjectFromClerk(auth, { globalRoles: "publicMetadata.staff" })`       | `subjectFromClerk(auth, { claims: { roles: "publicMetadata.staff" } })`             |
| `ClerkGlobalRoles`                                                      | `ClaimPath`                                                                         |

`subjectFromBetterSupabase` takes `claims` for roles, tenant and memberships and keeps its `plans` option, which decodes better-supabase's feature codes. `scimHandler` takes `claims: { tenant }` for a JWT that names its tenant elsewhere; the default is still `tenant`, then `tid`. The SQL side keeps one name per setting (`rls.tenantClaim`, `rls.roleClaim`), because the database reads a top-level claim by name.
