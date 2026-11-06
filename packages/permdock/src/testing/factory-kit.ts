let counter = 0;

/**
 * The next number of the shared sequence generated factories draw ids and names
 * from.
 */
export function sequence(): number {
  counter += 1;
  return counter;
}

/** Restarts the sequence, so a test reads the same rows on every run. */
export function resetFactories(): void {
  counter = 0;
}

/** A reference to another row: its id, or the row itself. */
export type FactoryRef = string | { readonly id: string };

/** The id a `FactoryRef` names. */
export function idOf(ref: FactoryRef): string {
  return typeof ref === "string" ? ref : ref.id;
}

/** A UUID that is the same on every run of a test. */
export function factoryUuid(): string {
  return `00000000-0000-4000-8000-${String(sequence()).padStart(12, "0")}`;
}

/** A string for `field` between `min` and `max` characters. */
export function factoryText(field: string, min: number, max: number): string {
  return `${field}-${String(sequence())}`.padEnd(min, "x").slice(0, max);
}
