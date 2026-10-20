---
"permdock": patch
---

The better-supabase adapter page documents how `act.read_only`, `act.tools` and `team_ids` are read by each library, and that an agent token needs a policy delegation to `actor("agent")`. The `next-better-supabase` example adds `quotes.read` and `quotes.update` agent tools and a stack test for `agent-tool-not-delegated` and read-only write refusal.
