import { createPermDock, type Snapshot } from 'permdock';

import { memberUser, policy } from './policy.ts';

function memberSnapshotValue(): Snapshot {
  const dock = createPermDock(policy, memberUser);
  if (dock instanceof Promise) {
    throw new TypeError('expected sync createPermDock');
  }
  const snapshot = dock.snapshot();
  if (typeof snapshot === 'string') {
    throw new TypeError('expected JSON snapshot');
  }
  return snapshot;
}

export const memberSnapshot: Snapshot = memberSnapshotValue();
