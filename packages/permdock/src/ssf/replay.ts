import type { ReplayStore } from "./types.ts";

export function memoryReplayStore(): ReplayStore {
  const seen = new Map<string, number | undefined>();

  function evict(now = Date.now() / 1000): void {
    for (const [jti, expiresAt] of seen) {
      if (expiresAt !== undefined && expiresAt <= now) {
        seen.delete(jti);
      }
    }
  }

  return {
    seen(jti: string): boolean {
      evict();
      return seen.has(jti);
    },
    remember(jti: string, expiresAt?: number): void {
      evict();
      seen.set(jti, expiresAt);
    },
    claim(key: string, expiresAt?: number): boolean {
      evict();
      if (seen.has(key)) {
        return false;
      }
      seen.set(key, expiresAt);
      return true;
    },
    release(key: string): void {
      seen.delete(key);
    },
  };
}
