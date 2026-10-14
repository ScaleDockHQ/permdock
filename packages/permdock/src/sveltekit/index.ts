export { createPermDock } from "./create.ts";
export type {
  SvelteKitGuarded,
  SvelteKitHandle,
  SvelteKitPermDock,
  SvelteKitPermDockEvent,
  SvelteKitPermDockLocals,
  SvelteKitPermDockOptions,
  SvelteKitProtect,
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
