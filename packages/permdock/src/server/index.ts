export { createPermDock } from "./create.ts";
export type {
  Guard,
  OpenApiHooks,
  ProtectOptions,
  ServerPermDock,
  ServerPermDockOptions,
} from "./create.ts";
export type {
  Connection,
  ConnectionData,
  ConnectionOptions,
} from "./connection.ts";
export {
  apiKeyVerifier,
  generateApiKey,
  hashApiKey,
  memoryCredentials,
  parseApiKey,
  subjectFromApiKey,
} from "./credentials.ts";
export type {
  ApiKeyFailureCause,
  ApiKeyParts,
  ApiKeySubjectOptions,
  MemoryCredentials,
  StoredCredential,
} from "./credentials.ts";
export { createEvaluationsHandler } from "./evaluations.ts";
export { problemFromError } from "./map-error.ts";
export type { ProblemFromErrorOptions } from "./map-error.ts";
export {
  PROBLEM_BASE,
  problemFromDecision,
  problemResponse,
  validationProblem,
  wwwAuthenticate,
} from "./problem.ts";
export {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockRevokedError,
  PermDockValidationError,
} from "../core/errors.ts";
export { memoryRevocationFeed } from "../core/revocations.ts";
export type { ApprovalHint } from "../core/errors.ts";
export type { RevocationEvent, RevocationFeed } from "../core/revocations.ts";
export {
  InvalidSignatureError,
  discoverViaSignatureAgent,
  invalidSignatureProblem,
  invalidSignatureResponse,
  verifyWebBotAuth,
} from "./web-bot-auth.ts";
export type {
  DiscoverViaSignatureAgentOptions,
  WebBotAuthJwk,
  WebBotAuthKeyLookup,
  WebBotAuthKeys,
  WebBotAuthOptions,
  WebBotAuthVerifier,
} from "./web-bot-auth.ts";
