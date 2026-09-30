const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export const MAX_GROUP_DEPTH = 10;

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key);
}

export function assertSafeKey(key: string, context: string): void {
  if (isForbiddenKey(key) || key.length === 0) {
    throw new Error(`PermDock: forbidden ${context} key '${key}'`);
  }
}

export function ownGet(object: object, key: string): unknown {
  if (isForbiddenKey(key)) {
    return undefined;
  }
  if (!Object.hasOwn(object, key)) {
    return undefined;
  }
  // SAFETY: key is a non-forbidden own property of object, checked above; the value stays unknown.
  return (object as Record<string, unknown>)[key];
}

export function ownKeys(object: object): readonly string[] {
  return Object.keys(object).filter((key) => !isForbiddenKey(key));
}

export function splitPath(path: string): readonly string[] {
  return path.split('.').filter((segment) => segment.length > 0);
}

export function readPath(root: unknown, path: string): unknown {
  const segments = splitPath(path);
  let current: unknown = root;
  for (const segment of segments) {
    if (isForbiddenKey(segment)) {
      return undefined;
    }
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object'
    ) {
      return undefined;
    }
    current = ownGet(current, segment);
  }
  return current;
}
