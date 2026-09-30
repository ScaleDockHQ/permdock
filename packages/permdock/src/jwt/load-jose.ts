import type * as Jose from 'jose';

export type JoseModule = typeof Jose;

let cached: Promise<JoseModule> | undefined;

export function loadJose(): Promise<JoseModule> {
  cached ??= import('jose').catch((cause: unknown) => {
    cached = undefined;
    throw new Error(
      'PermDock: permdock/jwt requires the optional peer "jose".',
      { cause },
    );
  });
  return cached;
}
