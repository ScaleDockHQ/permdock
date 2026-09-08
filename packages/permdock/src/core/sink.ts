import type { DecisionEvent, DecisionSink } from './interfaces.ts';

export function memorySink(
  options: { readonly capacity?: number } = {},
): DecisionSink & { readonly events: () => readonly DecisionEvent[] } {
  const capacity = options.capacity ?? 10_000;
  const buffer: DecisionEvent[] = [];
  return {
    write(events: readonly DecisionEvent[]): void {
      buffer.push(...events);
      if (buffer.length > capacity) {
        buffer.splice(0, buffer.length - capacity);
      }
    },
    events(): readonly DecisionEvent[] {
      return [...buffer];
    },
  };
}
