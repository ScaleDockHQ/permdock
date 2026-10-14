export { createPermDock } from "./create.ts";
export type {
  FastifyPermDock,
  FastifyPermDockOptions,
  FastifyProtect,
  FastifyPermDockRequest,
} from "./create.ts";
export { sendReply, toRequest } from "./http.ts";
export {
  discoverViaSignatureAgent,
  InvalidSignatureError,
  webBotAuthVerifier,
} from "../server/web-bot-auth.ts";
