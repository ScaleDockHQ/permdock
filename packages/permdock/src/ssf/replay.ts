import type { ReplayStore } from './types.ts';

export function memoryReplayStore(): ReplayStore {
  const seen = new Set<string>();
  return {
    seen(jti: string): boolean {
      return seen.has(jti);
    },
    remember(jti: string): void {
      seen.add(jti);
    },
  };
}
