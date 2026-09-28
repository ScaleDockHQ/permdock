import type {
  DecisionSink,
  MembershipEvent,
  SinkEvent,
  TokenSigner,
} from './interfaces.ts';

import { compact } from './compact.ts';

/** The closed list of CloudEvents `type` values PermDock emits. */
export const CLOUD_EVENT_TYPES: {
  readonly decision: 'dev.permdock.decision';
  readonly approval: 'dev.permdock.approval';
  readonly directory: 'dev.permdock.directory';
  readonly membership: 'dev.permdock.membership';
  readonly catalog: 'dev.permdock.catalog';
} = Object.freeze({
  decision: 'dev.permdock.decision',
  approval: 'dev.permdock.approval',
  directory: 'dev.permdock.directory',
  membership: 'dev.permdock.membership',
  catalog: 'dev.permdock.catalog',
});

export type CloudEventType =
  (typeof CLOUD_EVENT_TYPES)[keyof typeof CLOUD_EVENT_TYPES];

/** Why a published catalog broke a live hosted grant, which the Cloud then suspends. */
export type CatalogFindingCode =
  | 'permission-removed'
  | 'not-hostable'
  | 'grantee-removed'
  | 'approval-tightened';

/** One drift finding: the permission key and, when one broke, the hosted grant id. */
export type CatalogFinding = {
  readonly code: CatalogFindingCode;
  readonly permission: string;
  readonly grant?: string;
};

/** `data` of a `dev.permdock.catalog` event: a `permdock cloud push` or a drift against live hosted grants. */
export type CatalogEventData = {
  readonly kind: 'publish' | 'drift';
  /** The catalog fingerprint after the publish, or the one drift was measured against. */
  readonly fingerprint: string;
  readonly previous?: string;
  readonly findings?: readonly CatalogFinding[];
};

export type CloudEvent = {
  readonly specversion: '1.0';
  readonly type: CloudEventType;
  readonly source: string;
  readonly subject?: string;
  readonly id: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: SinkEvent | CatalogEventData;
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
      return CLOUD_EVENT_TYPES.directory;
    case 'membership':
      return CLOUD_EVENT_TYPES.membership;
    case 'decision':
      if (event.phase === 'requested' || event.phase === 'resolved') {
        return CLOUD_EVENT_TYPES.approval;
      }
      return CLOUD_EVENT_TYPES.decision;
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
  if (event.type === 'membership') {
    return event.principal.id;
  }
  return event.permission;
}

export function membershipEvent(input: {
  readonly source: string;
  readonly operation: MembershipEvent['operation'];
  readonly principal: MembershipEvent['principal'];
  readonly tenant?: string;
  readonly team?: string;
  readonly via?: string;
  readonly roles: MembershipEvent['roles'];
  readonly by?: MembershipEvent['by'];
  readonly at?: string;
}): MembershipEvent {
  return compact<MembershipEvent>({
    type: 'membership',
    at: input.at ?? new Date().toISOString(),
    source: input.source,
    operation: input.operation,
    principal: input.principal,
    tenant: input.tenant,
    team: input.team,
    via: input.via,
    roles: input.roles,
    by: input.by,
  });
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
