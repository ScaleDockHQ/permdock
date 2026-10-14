---
"permdock": minor
---

`permdock/workflow` adds automations. `permdock.decideAutomation` checks a publisher may hand out an automation's operations and returns an `Automation` record; `createPermDock` from `permdock/workflow` starts runs as run tickets, rebuilds each step with the publisher's live rights narrowed to the automation, and waits on approvals through an `ApprovalWaiter` such as `pollingApprovalWaiter`. `openApproval` and `resumeApproval` split that wait into two steps for runners that park a run themselves.
