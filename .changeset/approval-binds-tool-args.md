---
"permdock": patch
---

An approval for a tool call now covers only the arguments the approver saw. A tool without a `data` loader decided with no data, so its approval token held key, subject and actor only, and approving `send_email({ to: 'boss@corp' })` also approved `send_email({ to: 'attacker@evil' })`. The agent kernel (AI SDK, OpenAI Agents, Claude Agent SDK, Eve, A2A) and `permdock/mcp` now pass the tool arguments as the new `args` decide option, and the token binds their digest for row and collection tools alike. A pending approval asked before the upgrade no longer matches its retry and is asked again.
