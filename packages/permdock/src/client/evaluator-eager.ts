import type { Evaluator } from "./store-core.ts";

import { buildInstance } from "./evaluator.ts";

/** The evaluator in the entry itself, for adapters that render without Suspense. */
export const eagerEvaluator: Evaluator = {
  build: () => buildInstance,
  load: () => Promise.resolve(),
};
