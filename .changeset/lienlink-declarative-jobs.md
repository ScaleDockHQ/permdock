---
"permdock": minor
---

Lienlink files that go once it upgrades: `supabase/schemas/job_parties/040_rls.sql` (the `follows` part writes those policies), `private.trg_drop_platform_custom_role` (the cascade trigger deletes a platform role's grants for a staff caller with no membership), `trg_role_permissions_assignable` and its `pg_trigger_depth` guard (`customRoles.from.sync: "trigger"` guards a signed-in write), and the `scopeChallenge` delete in `apps/mcp/src/handler.ts` (a session token raises no scope challenge). `supabase/schemas/realtime/authz.sql` goes too: `generate` writes the receive policy only to `supabase/service/realtime/authz.sql`. The `declarative-jobs` fixture matches Lienlink's config, and a second `generate` writes nothing.
