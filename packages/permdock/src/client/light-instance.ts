import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { ClientBundle, Snapshot } from "../core/snapshot-types.ts";

import { compact } from "../core/compact.ts";
import { expandSnapshot } from "../core/snapshot-compact.ts";
import { snapshotReads } from "../core/snapshot-reads.ts";
import { subjectFromSnapshot } from "../core/snapshot-subject.ts";

const NOT_LOADED: Decision = {
  outcome: "denied",
  denials: [{ role: null, reason: "no-grant" }],
  alternatives: [],
};

/**
 * What a store holds until its evaluator loads: the reads a snapshot answers
 * alone, and a denial for every check. `usePermDock` suspends until the
 * evaluator replaces it, so no render sees the denials.
 */
export function lightInstance(
  snapshot: Snapshot,
  options: { readonly tenant?: string; readonly bundle?: ClientBundle },
): PermDock {
  const expanded = expandSnapshot(
    snapshot,
    compact({ bundle: options.bundle }),
  );
  const subject = subjectFromSnapshot(expanded, options.tenant);
  const reads = snapshotReads(expanded, subject);
  // SAFETY: the members that evaluate are absent; the store never exposes this instance to a check, and the two it may call, can and decide, deny.
  return {
    ...reads,
    subject,
    roles: snapshot.vocabulary?.roles ?? {},
    plans: snapshot.vocabulary?.plans ?? {},
    permissions: {},
    can: () => false,
    decide: () => NOT_LOADED,
    snapshot: () => snapshot,
    tenant: (id: string) =>
      lightInstance(snapshot, compact({ tenant: id, bundle: options.bundle })),
  } as unknown as PermDock;
}
