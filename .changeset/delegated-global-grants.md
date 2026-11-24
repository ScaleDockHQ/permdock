---
"permdock": minor
---

`rls generate` refuses global grants to delegated tokens in `permdock_has`. A token with an API key claim holds a global grant only when `rls.apiKeys` caps it by its scopes, and a token with a non-empty `client_id` or an `act` only when `rls.tokenScopes` caps it by its `scope` claim. Before, a policy delegation that left platform permissions out did not reach SQL, so an OAuth client a platform admin authorized could insert into a global-roles table or call a definer function gated by `permdock_has` with the admin's own global roles. The helper memo keys those tokens apart from the user's session, and the `_for` helpers, which name their user, are unchanged. Regenerate after upgrading; a project that relies on OAuth clients or API keys holding global grants sets `rls.tokenScopes` or `rls.apiKeys`.
