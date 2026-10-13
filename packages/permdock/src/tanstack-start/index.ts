export { createPermDock } from "./create.ts";
export type {
  TanStackStartGuardedContext,
  TanStackStartMiddleware,
  TanStackStartPermDock,
  TanStackStartPermDockContext,
  TanStackStartPermDockHandlers,
  TanStackStartPermDockOptions,
  TanStackStartProtect,
  TanStackStartRouteHandler,
} from "./create.ts";
export type { ContextReader, ProtectTarget } from "../server/fetch-adapter.ts";
export {
  discoverViaSignatureAgent,
  InvalidSignatureError,
  webBotAuthVerifier,
} from "../server/web-bot-auth.ts";
