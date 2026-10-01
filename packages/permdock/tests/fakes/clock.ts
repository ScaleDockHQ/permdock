export type FakeClock = {
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  readonly seconds: () => number;
  readonly date: () => Date;
  /** Resolves at once and advances the clock by `ms`. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly advance: (ms: number) => void;
  readonly slept: readonly number[];
};

/** A clock that only moves when told to, or when something sleeps on it. */
export function fakeClock(start = Date.UTC(2026, 0, 1)): FakeClock {
  let current = start;
  const slept: number[] = [];
  return {
    now: () => current,
    seconds: () => Math.floor(current / 1000),
    date: () => new Date(current),
    sleep: async (ms) => {
      slept.push(ms);
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
    slept,
  };
}
