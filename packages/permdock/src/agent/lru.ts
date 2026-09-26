/** A `Map` that drops its least recently used entry past `limit`. */
export type BoundedMap<K, V> = {
  readonly get: (key: K) => V | undefined;
  readonly set: (key: K, value: V) => void;
  readonly delete: (key: K) => void;
  readonly size: () => number;
};

export function boundedMap<K, V>(limit: number): BoundedMap<K, V> {
  const map = new Map<K, V>();
  return {
    get: (key) => {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set: (key, value) => {
      map.delete(key);
      map.set(key, value);
      if (map.size > limit) {
        const oldest = map.keys().next();
        if (oldest.done !== true) {
          map.delete(oldest.value);
        }
      }
    },
    delete: (key) => {
      map.delete(key);
    },
    size: () => map.size,
  };
}
