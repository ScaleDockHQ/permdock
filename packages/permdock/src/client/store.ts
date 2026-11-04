import type { ClientStore, ClientStoreOptions } from "./store-core.ts";

import { eagerEvaluator } from "./evaluator-eager.ts";
import { createStore } from "./store-core.ts";

export type { ClientStore, ClientStoreOptions } from "./store-core.ts";
export { storeOf } from "./store-core.ts";

/**
 * A store that carries its evaluator; the React provider loads it on demand
 * instead.
 */
export function createClientStore(options: ClientStoreOptions): ClientStore {
  return createStore(options, eagerEvaluator);
}
