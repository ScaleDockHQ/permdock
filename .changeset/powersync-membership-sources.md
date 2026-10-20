---
"permdock": minor
---

`permdock powersync generate` reads `rls.membershipSources` for a scope `rls.memberships` does not map, and syncs tenant custom roles per level, with `sqlFunction` conditions compiled through their `twin`. The stream for a deciding column's role is the union of every source that holds the role. Tables outside `public` are queried as `"<schema>"."<table>"`, and are renamed on the device to `<schema>_<table>` only when another synced table has the same name.

`powerSyncSource(db, { manifest, user, tenant?, attributes? })` builds the snapshot from the tables named in the manifest's new `rows` section. `powersync verify` now fails on a granted row that no stream syncs unless `generate` warned for it. With a database, it also fails with PD058 when a synced table is missing from the `powersync` publication. `permdock doctor` reports PD058 for each membership source with no stream form.
