---
"permdock": minor
---

`permdock/approvals` exports the list-paging helpers the built-in stores use, so a custom `ApprovalStore` no longer copies them: `pageApprovals(matching, query)` pages requests filtered in memory, `approvalPageSize`, `encodeApprovalCursor` and `decodeApprovalCursor` (with the `ApprovalCursorPosition` type) serve a store that pages in its own query, and `listAllApprovals(store, filter)` follows `next` to the last page.
