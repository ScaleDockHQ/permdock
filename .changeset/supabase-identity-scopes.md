---
"permdock": minor
---

`subjectFromSupabase` and `delegationOf` leave the OpenID Connect identity scopes (`openid`, `profile`, `email`, `address`, `phone`, `offline_access`) out of `delegation.scopes`. A Supabase OAuth server token that carries only those scopes is now an `oauth-client` actor with no delegation: it is still denied every check with `no-delegation` by default, and a policy `delegations` entry that names the client now lets it act within that ceiling. Before, the identity scopes counted as a token delegation that covered nothing, so the client was denied with `not-delegated` even when the policy delegated to it.
