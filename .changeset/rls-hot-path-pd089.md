---
"permdock": minor
---

`permdock doctor` PD089 also reads `create function` bodies and the `= any(array(select permitted_*_rows(…)))` form, and recommends `permitted_<resource>_row(id, permission)`. A measurement on 5,000 rows in 10 tenants shows the generated row helpers already read `permitted_<scope>_ids_by_permission` once per statement, so the generated SQL is unchanged; `tests/integration/bench/row-helpers-hot-path.test.ts` records the numbers.
