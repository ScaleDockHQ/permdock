---
"permdock": minor
---

`allow(permission, { requires })` accepts a list: `requires: [file.read, file.download]` counts the grant only on rows where the subject holds every listed permission through a role, each checked globally or on the row's scope instance as before. `permdock rls generate` ANDs one helper check per key, and the catalog lists the keys as an array when there are several (a single key stays a string). Breaking: `Grant.requires` on a normalized grant is now a `readonly string[]` instead of a `string`.
