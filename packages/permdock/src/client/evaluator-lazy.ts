import type { Evaluator, InstanceBuilder } from "./store-core.ts";

// A render that suspends on first mount discards the store it created, so the
// load has to outlive any one store. The cell holds code, never request data,
// and is written once (docs/decisions/0058-react-evaluator-split.md).
const loaded: { build?: InstanceBuilder; promise?: Promise<void> } = {};

/**
 * Fetches the evaluator on first use. The `import()` is a chunk of its own: a
 * page that only reads `typeLevel` answers never downloads it.
 */
export function lazyEvaluator(): Evaluator {
  return {
    build: () => loaded.build,
    load: () => {
      // A dynamic import keeps the evaluator out of the entry chunk; this is the measured client cost the split removes.
      loaded.promise ??= (async (): Promise<void> => {
        loaded.build = (await import("./evaluator.ts")).buildInstance;
      })();
      return loaded.promise;
    },
  };
}
