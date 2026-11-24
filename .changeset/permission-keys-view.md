---
"permdock": minor
---

The generated helpers read the permission-to-grant-key map from one view, `<schema>.permission_keys(permission, scope, effect, grant_key, conditioned)`, instead of inlining it in `grant_keys`, every `permitted_<scope>_permission_keys` and `permdock_bootstrap_permissions`.
