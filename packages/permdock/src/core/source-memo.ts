import type { SourceMemo } from "./interfaces.ts";

/**
 * One memo per `getPermDock` call. A read that throws is not kept, so the next
 * caller tries again.
 */
export function sourceMemo(): SourceMemo {
  const answers = new Map<string, unknown>();
  return <T>(key: string, read: () => T): T => {
    if (answers.has(key)) {
      // SAFETY: every key is written once below with the answer of a read of the same T.
      return answers.get(key) as T;
    }
    const answer = read();
    answers.set(key, answer);
    return answer;
  };
}
