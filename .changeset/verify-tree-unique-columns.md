---
"permdock": patch
---

`rls verify --tree` seeds a different value in each row for a required column that a unique index covers. Sibling rows got the same placeholder before, so a table with a unique index such as `(drive_id, parent_id, name)`, or a unique uuid column, refused the seed and the command could not run. Text gets a numbered placeholder, a uuid a new value, a number counts up from its check's bound and a date moves a day per row; a column whose enum or equality check allows one value keeps it.
