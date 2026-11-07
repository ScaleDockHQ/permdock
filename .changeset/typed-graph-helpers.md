---
"permdock": minor
---

Breaking: `permitted_<resource>_ids` and `permdock_link_<resource>_<link>` return the resource id type from `rls.idTypes`. Callers compare that type directly. A closure comparison casts `ancestor` and `descendant` to the id type. The closure table itself stays `text`.
