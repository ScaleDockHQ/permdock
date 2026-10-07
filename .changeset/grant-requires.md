---
"permdock": minor
---

`allow(permission, { requires })` makes a grant count only where the subject also holds another permission through a role: `allow(drive.read, { to: relation(drive, 'viewer'), requires: file.read })` keeps a share to the organizations where the user holds `file.read`. The requirement is met by a role grant without a row condition, declared or custom, globally or on the row's scope instance, minus a deny of that permission at the same instance. It folds into the grant's row condition for `can`, `where()` and snapshots, and `permdock rls generate` checks it with `permdock_has_permission` and `permitted_<scope>_ids_by_permission`. `definePolicy` rejects it on a deny, on a collection action and for an undeclared permission.
