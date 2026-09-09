export { createPermDock } from './create.ts';
export type {
  Guard,
  OpenApiHooks,
  ServerPermDock,
  ServerPermDockOptions,
} from './create.ts';
export { createEvaluationsHandler, createHandler } from './evaluations.ts';
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
  PermDockValidationError,
} from '../core/errors.ts';
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
