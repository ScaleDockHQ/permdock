---
"permdock": minor
---

`permdock/supabase` reads an agent `act` level as better-supabase does: `act.read_only` becomes `readOnly` (default `false`). A level with `session_id`, `tools` that are not non-empty strings or a non-boolean `read_only` is `invalid-chain`. An actor with `readOnly: true` is denied every permission without `readOnlyHint` (`not-delegated`), with or without a policy delegation. `permdock_actor_may_write()` and the `rls.readOnlyActors` policies refuse a write by an agent with `read_only: true`.

Breaking: an `agent` actor's `tools` list is enforced. `permdock/agent`, the agent adapters and `permdock/mcp` deny any tool it does not name with the new denial reason `agent-tool-not-delegated` and hide it from tool lists. better-supabase's `agentClaims` writes `tools: []` unless given a list, so mint agent tokens with `tools` set to the tools the run may call.
