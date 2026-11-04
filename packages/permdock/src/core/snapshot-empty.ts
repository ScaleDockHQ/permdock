import type { Snapshot } from "./snapshot-types.ts";

import { freezeDeep } from "./freeze.ts";

export function emptySnapshot(): Snapshot {
  return freezeDeep({
    v: 1 as const,
    issuedAt: "1970-01-01T00:00:00.000Z",
    subject: { principal: null, context: {} },
    roles: [],
    grants: [],
    tenants: [],
  });
}
