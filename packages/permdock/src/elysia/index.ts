export { createPermDock } from "./create.ts";
export type {
  ElysiaPermDockContext,
  ElysiaRequestContext,
  ElysiaPermDock,
  ElysiaPermDockOptions,
  ElysiaProtect,
  ElysiaSocket,
} from "./create.ts";
export {
  discoverViaSignatureAgent,
  InvalidSignatureError,
  verifyWebBotAuth,
} from "../server/web-bot-auth.ts";
