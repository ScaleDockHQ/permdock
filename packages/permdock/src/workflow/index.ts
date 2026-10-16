export { createPermDock } from "./create.ts";
export type {
  AwaitApprovalOptions,
  AutomationOptions,
  StartAutomationResult,
  WorkflowPermDock,
  WorkflowPermDockOptions,
} from "./create.ts";
export { pollingApprovalWaiter } from "./waiter.ts";
export type {
  ApprovalWaitOptions,
  ApprovalWaiter,
  PollingApprovalWaiterOptions,
} from "./waiter.ts";
export { memoryAutomationSource, parseAutomation } from "../core/automation.ts";
export type {
  Automation,
  AutomationDecision,
  AutomationMode,
  AutomationRequest,
  AutomationSource,
  MemoryAutomationSource,
} from "../core/automation.ts";
