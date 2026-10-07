---
"permdock": minor
---

`permitted_<scope>_permission_keys(p_id)` and its `_for` form now answer in one set-based query: the roles, memberships, custom roles and grant keys the subject holds are read once for all keys instead of through two helper calls per declared key, so a 190-key catalog answers in a few milliseconds instead of over a hundred. A new overload `permitted_<scope>_permission_keys(p_id, p_keys)` (and `_for(p_user, p_id, p_keys)`) answers for the listed keys only. The answers are unchanged.
