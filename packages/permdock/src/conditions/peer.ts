/**
 * Requires an optional peer through `node:module`. Feature-detected so the
 * entry loads on runtimes without a Node module loader; there the caller
 * injects the peer and `message` names the option that does it.
 */
export function loadPeer<T>(id: string, message: string): T {
  // SAFETY: optional chaining guards a missing process; node:module is Node's createRequire module.
  const loader = (
    globalThis as {
      readonly process?: {
        readonly getBuiltinModule?: (id: string) => unknown;
      };
    }
  ).process?.getBuiltinModule?.("node:module") as
    | { readonly createRequire: (from: string) => (id: string) => unknown }
    | undefined;
  try {
    if (loader === undefined) {
      throw new Error("no module loader");
    }
    // SAFETY: the caller names the peer whose exports `T` describes.
    return loader.createRequire(import.meta.url)(id) as T;
  } catch {
    throw new Error(message);
  }
}
