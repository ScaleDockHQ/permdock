function refuse(): never {
  throw new TypeError("PermDock: this collection is frozen");
}

const LOCKED = { value: refuse, writable: false, enumerable: false };

/**
 * `Object.freeze` leaves a `Map` or `Set` writable through `set`, `add`,
 * `delete` and `clear`, so those are shadowed on the instance with a method
 * that throws. Identity and `instanceof` stay as they were.
 */
function freezeCollection(value: Map<unknown, unknown> | Set<unknown>): void {
  Object.defineProperties(
    value,
    value instanceof Map
      ? { set: LOCKED, delete: LOCKED, clear: LOCKED }
      : { add: LOCKED, delete: LOCKED, clear: LOCKED },
  );
  Object.freeze(value);
  for (const [key, item] of value.entries()) {
    freezeDeep(key);
    freezeDeep(item);
  }
}

export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (value instanceof Map || value instanceof Set) {
    freezeCollection(value);
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeDeep(item);
    }
    return value;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    // SAFETY: value is a non-null object checked above and key is one of its own property names.
    freezeDeep((value as Record<string, unknown>)[key]);
  }
  return value;
}

function isPlain(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A deeply frozen copy of the plain objects and arrays in `value`; the caller's
 * own objects stay writable.
 */
export function freezeCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    // SAFETY: a copy of an array of T's elements has T's array type.
    return Object.freeze(value.map((item: unknown) => freezeCopy(item))) as T;
  }
  if (!isPlain(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    // SAFETY: value is a non-null plain object and key is one of its own keys.
    copy[key] = freezeCopy((value as Record<string, unknown>)[key]);
  }
  // SAFETY: the copy has the same own enumerable keys and values as value.
  return Object.freeze(copy) as T;
}

export function freezeShallow<T extends object>(value: T): T {
  return Object.freeze(value);
}

/**
 * Whether `value` and everything it reaches through plain objects and arrays is
 * frozen. A frozen graph cannot change, so a result computed from it once stays
 * correct: that is what a per-object memo may rely on.
 */
export function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (!Object.isFrozen(value)) {
    return false;
  }
  if (value instanceof Map || value instanceof Set) {
    return false;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    // SAFETY: value is a non-null object checked above and key is one of its own property names.
    if (!isDeepFrozen((value as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

/**
 * `compute(value)`, remembered per object while `value` is deeply frozen. An
 * object that is not frozen is computed every time, since it may change between
 * calls.
 */
export function memoByFrozenObject<T extends object, R>(
  memo: WeakMap<T, R>,
  value: T,
  compute: (input: T) => R,
): R {
  const known = memo.get(value);
  if (known !== undefined) {
    return known;
  }
  const result = compute(value);
  if (isDeepFrozen(value)) {
    memo.set(value, result);
  }
  return result;
}
