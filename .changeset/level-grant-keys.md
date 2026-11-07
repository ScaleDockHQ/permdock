---
"permdock": minor
---

Breaking: a level grant key is `<permission>@<level>`, with the level condition only. It is no longer crossed with a `#n` condition group, and `orderedLevels` no longer adds the lower levels to the SQL reach list. An empty level is the whole tenant.
