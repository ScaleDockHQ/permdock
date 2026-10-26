export { createPermDock } from "./create.ts";
export { APPROVAL_META_KEY } from "./mcp-auth.ts";
export {
  mcpResourceGuard,
  protectedResourceMetadata,
} from "./resource-guard.ts";
export type {
  McpResourceGuardOptions,
  McpResourceGuardResult,
  ProtectedResourceMetadataOptions,
} from "./resource-guard.ts";
export { subjectFromMcp } from "./subject.ts";
export type { McpSubjectOptions } from "./subject.ts";
export type { DeniedTextEvent, DeniedText } from "../agent/denied-text.ts";
export type {
  GuardedMcpServer,
  McpAuthInfo,
  McpOnError,
  McpPermDock,
  McpPermDockOptions,
  McpPrincipal,
  McpProcedureEnforcement,
  McpProcedureToolConfig,
  McpPromptConfig,
  McpResourceConfig,
  McpUiResourceConfig,
  McpToolConfig,
  ProcedureMcpServer,
} from "./types.ts";
