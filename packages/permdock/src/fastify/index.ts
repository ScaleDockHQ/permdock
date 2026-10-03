export { createPermDock } from './create.ts';
export type {
  FastifyPermDock,
  FastifyPermDockOptions,
  FastifyProtect,
  PermDockRequest,
} from './create.ts';
export { sendReply, toRequest } from './http.ts';
export {
  discoverViaSignatureAgent,
  InvalidSignatureError,
  verifyWebBotAuth,
} from '../server/web-bot-auth.ts';
