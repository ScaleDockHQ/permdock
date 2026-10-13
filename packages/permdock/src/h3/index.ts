export { createPermDock } from "./create.ts";
export type {
  H3PermDock,
  H3PermDockContext,
  H3PermDockEvent,
  H3PermDockOptions,
} from "./create.ts";
export type { ContextReader, ProtectTarget } from "../server/fetch-adapter.ts";
export {
  discoverViaSignatureAgent,
  InvalidSignatureError,
  webBotAuthVerifier,
} from "../server/web-bot-auth.ts";
