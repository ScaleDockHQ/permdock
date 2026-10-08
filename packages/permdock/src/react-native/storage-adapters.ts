import type { PermDockStorage } from "./types.ts";

/** The `expo-secure-store` functions `secureStoreStorage` calls. */
export type SecureStoreModule = {
  getItem(key: string, options?: object): string | null;
  setItem(key: string, value: string, options?: object): void;
  deleteItemAsync(key: string, options?: object): Promise<void>;
};

/** The `react-native-mmkv` instance methods `mmkvStorage` calls: `remove` (v4) or `delete` (v3). */
export type MmkvInstance = {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
} & ({ remove(key: string): unknown } | { delete(key: string): unknown });

/** SecureStore warns above 2048 bytes and may refuse larger values on some devices. */
const SECURE_STORE_CHUNK_BYTES = 2048;
const INDEX_PREFIX = "permdock-chunks:";

function utf8Length(char: string): number {
  const point = char.codePointAt(0) ?? 0;
  if (point < 0x80) {
    return 1;
  }
  if (point < 0x800) {
    return 2;
  }
  return point < 0x1_00_00 ? 3 : 4;
}

function split(value: string, max: number): string[] {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of value) {
    const size = utf8Length(char);
    if (bytes + size > max) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out;
}

function chunkCount(index: string | null): number | undefined {
  if (index?.startsWith(INDEX_PREFIX) !== true) {
    return undefined;
  }
  const count = Number(index.slice(INDEX_PREFIX.length));
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

function chunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

/**
 * A `PermDockStorage` over `expo-secure-store`. Values are split into chunks
 * of at most 2048 bytes under `<key>.<n>`; `<key>` holds the chunk count and
 * is written last, so an interrupted write reads as absent.
 */
export function secureStoreStorage(
  store: SecureStoreModule,
  options?: object,
): PermDockStorage {
  const removeChunks = async (
    key: string,
    from: number,
    to: number,
  ): Promise<void> => {
    for (let index = from; index < to; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- SecureStore deletes one key per call
      await store.deleteItemAsync(chunkKey(key, index), options);
    }
  };
  return {
    getItem: (key) => {
      const count = chunkCount(store.getItem(key, options));
      if (count === undefined) {
        return null;
      }
      let value = "";
      for (let index = 0; index < count; index += 1) {
        const part = store.getItem(chunkKey(key, index), options);
        if (part === null) {
          return null;
        }
        value += part;
      }
      return value;
    },
    setItem: async (key, value) => {
      const before = chunkCount(store.getItem(key, options)) ?? 0;
      await store.deleteItemAsync(key, options);
      const parts = split(value, SECURE_STORE_CHUNK_BYTES);
      for (const [index, part] of parts.entries()) {
        store.setItem(chunkKey(key, index), part, options);
      }
      store.setItem(key, `${INDEX_PREFIX}${parts.length}`, options);
      await removeChunks(key, parts.length, before);
    },
    removeItem: async (key) => {
      const before = chunkCount(store.getItem(key, options)) ?? 0;
      await store.deleteItemAsync(key, options);
      await removeChunks(key, 0, before);
    },
  };
}

/** A synchronous `PermDockStorage` over a `react-native-mmkv` instance: the first frame already has the snapshot. */
export function mmkvStorage(mmkv: MmkvInstance): PermDockStorage {
  return {
    getItem: (key) => mmkv.getString(key) ?? null,
    setItem: (key, value) => {
      mmkv.set(key, value);
    },
    removeItem: (key) => {
      if ("remove" in mmkv) {
        mmkv.remove(key);
      } else {
        mmkv.delete(key);
      }
    },
  };
}
