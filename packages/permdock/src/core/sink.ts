import type { DecisionSink, SinkEvent, TokenSigner } from './interfaces.ts';

import { compact } from './compact.ts';

export type CloudEventType =
  | 'dev.permdock.decision'
  | 'dev.permdock.approval'
  | 'dev.permdock.directory'
  | 'dev.permdock.catalog';

export type CloudEvent = {
  readonly specversion: '1.0';
  readonly type: CloudEventType;
  readonly source: string;
  readonly subject?: string;
  readonly id: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: SinkEvent;
};

export type SignDecisionBatchOptions = {
  readonly audience?: string | readonly string[];
  readonly source?: string;
};

export type MemorySinkOptions = {
  readonly capacity?: number;
  readonly signer?: TokenSigner;
  readonly audience?: string | readonly string[];
  readonly source?: string;
};

export type MemorySink = DecisionSink & {
  readonly events: () => readonly SinkEvent[];
  readonly batches: () => readonly string[];
};

function cloudEventType(event: SinkEvent): CloudEventType {
  switch (event.type) {
    case 'directory':
      return 'dev.permdock.directory';
    case 'decision':
      if (event.phase === 'requested' || event.phase === 'resolved') {
        return 'dev.permdock.approval';
      }
      return 'dev.permdock.decision';
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function cloudEventSubject(event: SinkEvent): string {
  if (event.type === 'directory') {
    return event.resource.id;
  }
  return event.permission;
}

export function toCloudEvent(
  event: SinkEvent,
  source = 'permdock',
): CloudEvent {
  return compact<CloudEvent>({
    specversion: '1.0',
    type: cloudEventType(event),
    source,
    subject: cloudEventSubject(event),
    id: globalThis.crypto.randomUUID(),
    time: event.at,
    datacontenttype: 'application/json',
    data: event,
  });
}

export function signDecisionBatch(
  events: readonly SinkEvent[],
  signer: TokenSigner,
  options: SignDecisionBatchOptions = {},
): Promise<string> {
  const source = options.source ?? 'permdock';
  return signer.sign(
    { events: events.map((event) => toCloudEvent(event, source)) },
    compact<Parameters<TokenSigner['sign']>[1]>({
      typ: 'permdock-decisions+jwt',
      audience: options.audience,
    }),
  );
}

export function memorySink(options: MemorySinkOptions = {}): MemorySink {
  const capacity = options.capacity ?? 10_000;
  const buffer: SinkEvent[] = [];
  const signed: string[] = [];
  return {
    write(events: readonly SinkEvent[]): void | Promise<void> {
      buffer.push(...events);
      if (buffer.length > capacity) {
        buffer.splice(0, buffer.length - capacity);
      }
      if (options.signer === undefined) {
        return;
      }
      return signDecisionBatch(
        events,
        options.signer,
        compact<SignDecisionBatchOptions>({
          audience: options.audience,
          source: options.source,
        }),
      )
        .then((batch) => {
          signed.push(batch);
        })
        .catch(() => undefined);
    },
    events(): readonly SinkEvent[] {
      return [...buffer];
    },
    batches(): readonly string[] {
      return [...signed];
    },
  };
}
