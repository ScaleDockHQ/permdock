export { createPermDock } from "./create.ts";
export type {
  SolidStartGuarded,
  SolidStartMiddleware,
  SolidStartNativeEvent,
  SolidStartPermDock,
  SolidStartPermDockEvent,
  SolidStartPermDockHandlers,
  SolidStartPermDockLocals,
  SolidStartPermDockOptions,
  SolidStartProtect,
} from "./create.ts";
export type { ContextReader, ProtectTarget } from "../server/fetch-adapter.ts";
export {
  discoverViaSignatureAgent,
  InvalidSignatureError,
  webBotAuthVerifier,
} from "../server/web-bot-auth.ts";
