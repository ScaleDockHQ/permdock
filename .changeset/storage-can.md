---
"permdock": minor
---

Breaking: a Storage bucket policy calls `can_<resource>` with the object id in the folder. It no longer calls `permitted_<scope>_ids_by_permission`, so the resource's row conditions apply.
