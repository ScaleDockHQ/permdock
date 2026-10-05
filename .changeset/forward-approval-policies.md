---
"permdock": minor
---

Every adapter `createPermDock` now takes `approvalPolicies` and passes it to the instance it builds: `permdock/next`, `permdock/server`, the HTTP adapters, `permdock/supabase/middleware`, `permdock/mcp`, `permdock/a2a`, `permdock/authzen`, `permdock/terminal`, `permdock/ai-sdk`, `permdock/claude-agent`, `permdock/eve` and `permdock/openai`. Before, only the core factory read it, so approval rules kept as data never applied to adapter decisions and `toolApproval` could not return `user-approval` for them.
