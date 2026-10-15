/**
 * The kit every HTTP adapter builds on: its runtime imports come from here
 * (and `../node/http.ts` for the Node request bridge), never from core or
 * another adapter. The lint rule in `oxlint.config.ts` enforces it; type
 * imports may still name core types directly.
 */
export { compact } from "../core/compact.ts";
export {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockRevokedError,
  PermDockValidationError,
} from "../core/errors.ts";
export { isPermission } from "../core/permission-registry.ts";
export { attached, bindKernel, decorate, socketConnection } from "./bind.ts";
export { fetchAdapter, guardedRoute, instanceRoute } from "./fetch-adapter.ts";
export {
  fetchRequest,
  firstHeader,
  hasCredentials,
  headersFrom,
  parsedBody,
  problemMessage,
  writeReply,
} from "./http.ts";
export { problemFromError } from "./map-error.ts";
export { bindRpcKernel, guardStream, problemBody, rpcCode } from "./rpc.ts";
export {
  POLICY_VIOLATION,
  closeReason,
  guardIterable,
  isAsyncIterable,
  onRevoked,
  reloadAfter,
} from "./stream.ts";
export {
  InvalidSignatureError,
  discoverViaSignatureAgent,
  webBotAuthVerifier,
} from "./web-bot-auth.ts";
