/**
 * The kit every UI adapter (`react`, `vue`, `svelte`, `solid`) builds on: its
 * runtime imports come from here, never from core or another adapter. The lint
 * rule in `oxlint.config.ts` enforces it. Client entries stay free of server
 * imports (invariant 8), so nothing here reaches one.
 */
export { boundaryDigest, boundaryFallback } from "./boundary.ts";
export { approvalHeaders } from "./headers.ts";
export { providerStore, switchTenant } from "./provider-store.ts";
export { eventSourceRefresh } from "./refresh-on.ts";
export { isPromiseLike } from "./source.ts";
export { adapterStore } from "./store-options.ts";
export { storeOf } from "./store.ts";
export {
  approvalHandle,
  describeWith,
  filterResult,
  gateView,
  livePermDock,
  permissionSet,
  protectedView,
  rolesView,
  scopedTenant,
  slotContent,
  subjectView,
  tenantView,
} from "./views.ts";
export { compact } from "../core/compact.ts";
export { describe, requiredPlans } from "../core/describe.ts";
export { emptySnapshot } from "../core/from-snapshot.ts";
