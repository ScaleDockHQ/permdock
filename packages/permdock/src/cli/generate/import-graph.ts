import { registerHooks } from "node:module";

/**
 * Records the module URLs Node loads while `run` is in progress, through
 * `module.registerHooks`. The set is local to the call. Under jiti the graph is
 * the files `module-values.ts` already walks; this hook covers native ESM.
 */
export async function withImportGraph<T>(
  run: () => Promise<T>,
): Promise<{ readonly value: T; readonly files: readonly string[] }> {
  const seen = new Set<string>();
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      seen.add(url);
      return nextLoad(url, context);
    },
  });
  try {
    const value = await run();
    return { value, files: [...seen].toSorted() };
  } finally {
    hooks.deregister();
  }
}
