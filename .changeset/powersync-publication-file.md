---
"permdock": minor
---

Under pg-delta, when a schema file creates the `powersync` publication, `permdock powersync generate` writes `alter publication powersync add table ...` to `<schemaDir>/permdock/powersync_publication.sql` instead of a comment in `sync-config.yaml`, so the declarative sync adds the synced tables outside `public`.
