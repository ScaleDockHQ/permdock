export { createPermDock } from './create.ts';
export type {
  Guard,
  OpenApiHooks,
  ProtectOptions,
  ServerPermDock,
  ServerPermDockOptions,
} from './create.ts';
export type {
  Connection,
  ConnectionData,
  ConnectionOptions,
} from './connection.ts';
export { createEvaluationsHandler, createHandler } from './evaluations.ts';
export { mapPermDockError as problemFromError } from './map-error.ts';
export {
  PROBLEM_BASE,
  problemFromDecision,
  problemResponse,
  validationProblem,
  wwwAuthenticate,
} from './problem.ts';
export {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockRevokedError,
  PermDockValidationError,
} from '../core/errors.ts';
export { memoryRevocationFeed } from '../core/revocations.ts';
export type { RevocationEvent, RevocationFeed } from '../core/revocations.ts';
export {
  InvalidSignatureError,
  discoverViaSignatureAgent,
  invalidSignatureProblem,
  invalidSignatureResponse,
} from './web-bot-auth.ts';
export type {
  DiscoverViaSignatureAgentOptions,
  WebBotAuthJwk,
  WebBotAuthKeyLookup,
  WebBotAuthKeys,
  WebBotAuthOptions,
} from './web-bot-auth.ts';
