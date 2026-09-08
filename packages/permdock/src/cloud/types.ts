import type { ApprovalStore } from '../approvals/types.ts';
import type { DecisionSink, SnapshotSource } from '../core/interfaces.ts';

export type CloudOptions = {
  readonly url?: string;
  readonly key?: string;
  readonly environment?: string;
  readonly fetch?: typeof fetch;
  readonly flushAt?: number;
  readonly waitUntil?: (task: Promise<void>) => void;
};

export type CloudClient = {
  readonly approvals: ApprovalStore;
  readonly sink: DecisionSink;
  readonly snapshots: SnapshotSource;
};
