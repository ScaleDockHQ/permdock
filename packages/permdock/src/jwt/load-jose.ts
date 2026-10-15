import type * as Jose from "jose";

export type JoseModule = typeof Jose;

export function loadJose(): Promise<JoseModule> {
  // Lazy: jose is an optional peer, loaded on the first verification. The
  // module loader caches the import, so no module-level state is kept here
  // (invariant 7).
  return import("jose").catch((cause: unknown) => {
    throw new Error(
      'PermDock: permdock/jwt requires the optional peer "jose".',
      { cause },
    );
  });
}
