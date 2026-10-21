---
"permdock": minor
---

`permdock rls verify --introspect` matches each `security definer` helper by its full signature, so an overloaded helper such as `permdock_permission_keys()` and `permdock_permission_keys(text)` no longer reports a random overload. Breaking for `rls.verify.ignore` and `--ignore`: helper finding ids now carry the signature, `helper-definer:permdock.permdock_has(text):helper` instead of `helper-definer:permdock.permdock_has:helper`.
