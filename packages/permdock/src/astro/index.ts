export { createPermDock } from "./create.ts";
export type {
  AstroGuarded,
  AstroPermDock,
  AstroPermDockContext,
  AstroPermDockLocals,
  AstroPermDockOptions,
  AstroProtect,
} from "./create.ts";
export type {
  ContextReader,
  PermDockHandlers,
  ProtectTarget,
} from "../server/fetch-adapter.ts";
export {
  discoverViaSignatureAgent,
  InvalidSignatureError,
  webBotAuthVerifier,
} from "../server/web-bot-auth.ts";
