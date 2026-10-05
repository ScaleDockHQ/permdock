---
"permdock": minor
---

`protectServer(server, { enforce: 'procedure', permissionFor })` in `permdock/mcp` lists and annotates tools by permission but leaves the call to the procedure the tool runs, so each call decides once. `permissionOf(procedure)` in `permdock/orpc` returns the permission of a procedure's `protect`.
