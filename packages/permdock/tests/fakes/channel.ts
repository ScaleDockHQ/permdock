/** A push queue whose `drain()` yields each pushed item and waits when empty. */
export function channel<T>(): {
  readonly push: (...items: T[]) => void;
  readonly drain: () => AsyncGenerator<T>;
} {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  const nextPush = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  return {
    push(...items: T[]): void {
      queue.push(...items);
      wake?.();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) {
          await nextPush();
        } else {
          yield next;
        }
      }
    },
  };
}
