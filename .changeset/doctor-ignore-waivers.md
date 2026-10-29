---
"permdock": minor
---

`permdock doctor` gives every finding a `target` and an `id` of `<code>:<target>`, and accepts findings through `doctor.ignore: [{ id, reason }]` and `--ignore`. `doctor.waivers: [{ code: "PD017", key, reason }]` silences PD017 for one permission key. PD080 and PD081 also accept `||=`, `if (!x) x = ...` and calls passed to a helper named in `doctor.cacheHelpers`. PD072 stays silent when the schema files, migrations or `rls.out` create `permdock_custom_role_name_guard`.
