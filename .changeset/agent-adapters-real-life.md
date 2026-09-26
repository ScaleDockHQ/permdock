---
'permdock': minor
---

Agent adapters, from real agent loops against a Postgres approval store:

- Every agent adapter resumes an approval without an in-process map: the token is recomputed from permission, resource, principal, actor and arguments and looked up in the `store`, so a fresh instance, replica or process resumes an approved call exactly once and a replay is denied with `approval-consumed`.
- `permdock/mcp` is rebuilt on `@modelcontextprotocol/server` 2. `protectServer` also guards `registerResource` and `registerPrompt`, requires a `permission` on every registration, filters `tools/list`, `resources/list`, `resources/templates/list` and `prompts/list` per caller (marked `cacheScope: 'private'`) and sends `notifications/tools/list_changed` when a caller's visible tools change. A missing scope is the SDK `scopeChallenge` step-up naming the union of scopes. `approval-required` is an `isError` result carrying the token, resumable with `_meta["dev.permdock/approval"]` (`APPROVAL_META_KEY`) or from the store. `requireAuthInfo` refuses calls without `authInfo`. New `subjectFromMcp` and `McpPrincipal`.
- `permdock/eve`: `approval.request(ctx)` and `approval.response(ctx)` take Eve's single context object (`EveApprovalContext`, `EveResponseContext`, `EvePrincipal`). Eve's re-check of a call nobody approved is denied instead of running the tool. The responder is mapped through the same `subject` as an initiator, so `grant.approval.by` sees their memberships and tenant, and any replica can answer.
- `permdock/openai`: `needsApproval` reads the SDK `RunContext` (`runContext.context`) and never touches the store; `resolveInterruptions` rejects unreadable calls and returns only the still-pending requests.
- `permdock/claude-agent`: takes the SDK's real `canUseTool` options and `PermissionRequest` hook input; approval-required is a deny carrying the pending token; `mcp__` tools are trusted only from `mcpSources` (default `['sdk']`) whose server name matches the tool prefix.
- `permdock/ai-sdk`: `capabilityMiddleware(context)` is a factory returning a `v4` `LanguageModelMiddleware`; `toolApproval` reads `runtimeContext` and the call's `input`.
- `permdock/a2a`: `input-required` tasks resume from the `store` (or the verified `auth.extra.approval`), and skill lookup ignores inherited names such as `__proto__`.
