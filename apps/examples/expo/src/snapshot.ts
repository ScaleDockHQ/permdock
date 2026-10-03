import { createPermDock, type Snapshot } from "permdock";

import { memberUser, policy } from "./policy.ts";

function memberSnapshotValue(): Snapshot {
  const permdock = createPermDock(policy, memberUser);
  if (permdock instanceof Promise) {
    throw new TypeError("expected sync createPermDock");
  }
  const snapshot = permdock.snapshot();
  if (snapshot instanceof Promise || typeof snapshot === "string") {
    throw new TypeError("expected JSON snapshot");
  }
  return snapshot;
}

export const memberSnapshot: Snapshot = memberSnapshotValue();
