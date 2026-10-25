---
"permdock": minor
---

`workflow.start(id, { resource: { type, id } })` binds a run to one record: the automation's permissions on that type go into an `authorization_details` entry with `identifier`, so they hold on that row only. The run ticket gains an optional `resource` claim (still `run-v1`), returned on `StartAutomationResult.run` and `subject.context.run`. `hookCan` and `handlerCan` from `permdock/better-supabase` take a `data` option that loads the row a permission is decided on.
