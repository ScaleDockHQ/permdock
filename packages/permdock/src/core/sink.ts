import type { DecisionSink, SinkEvent } from './interfaces.ts';

export function memorySink(
  options: { readonly capacity?: number } = {},
): DecisionSink & { readonly events: () => readonly SinkEvent[] } {
  const capacity = options.capacity ?? 10_000;
  const buffer: SinkEvent[] = [];
  return {
    write(events: readonly SinkEvent[]): void {
      buffer.push(...events);
      if (buffer.length > capacity) {
        buffer.splice(0, buffer.length - capacity);
      }
    },
    events(): readonly SinkEvent[] {
      return [...buffer];
    },
  };
}
