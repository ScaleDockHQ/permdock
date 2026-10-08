export { createPermDock } from "./create.ts";
export { decorateMethod } from "./decorate.ts";
export type {
  NestPermDock,
  NestHandlerOptions,
  PermDockModuleOptions,
  NestPermDockOptions,
  NestProtect,
  NestRequest,
  NestSocket,
} from "./create.ts";
export { sendResponse, toRequest } from "./http.ts";
export {
  discoverViaSignatureAgent,
  InvalidSignatureError,
  verifyWebBotAuth,
} from "../server/web-bot-auth.ts";
