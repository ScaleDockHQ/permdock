---
"permdock": patch
---

`rls verify --introspect --helpers-only` accepts a `<permission>@<level>` key the resource declares instead of reporting it as undeclared. A conditioned level such as `job.create@own` passed to `permitted_<scope>_ids` is an `info` line naming `permitted_job_row(job, 'job.create')`, the row helper that applies the level. The docs give the insert policy form with the table's row reference, not `new`.
