---
"permdock": minor
---

New `permdock/chat` entry. `subjectFromChat` resolves a verified `ChatAuthor` through `principalByIdentity`, and an unlinked author is anonymous. `createPermDock` returns `ChatPermDock`: `protect(operation, handler)` decides each command as that principal and opens one approval request per command, and `resolveAction` applies an approve or reject verdict by request id. The requester never approves their own request.
