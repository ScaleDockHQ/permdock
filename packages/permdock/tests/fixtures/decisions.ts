import type { DecisionEvent } from '../../src/core/interfaces.ts';
import type { PermDock } from '../../src/core/permdock.ts';
import type { Permission } from '../../src/core/permissions.ts';
import type { Decision } from '../../src/index.ts';

/** The first denial reason of a denied decision; `undefined` for any other outcome. */
export function reasonOf(decision: Decision): string | undefined {
  return decision.outcome === 'denied'
    ? decision.denials[0]?.reason
    : undefined;
}

/** A decision event, as `on('decision')` hands over or a sink buffers next to other event types. */
export function isDecisionEvent(event: unknown): event is DecisionEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'decision'
  );
}

type DecideEither = {
  readonly decide: (permission: Permission, data?: unknown) => Decision;
};

/** `permdock.decide` for a leaf whose kind is only known at run time, as when looping over `listPermissions`. */
export function decideLeaf(
  permdock: Pick<PermDock, 'decide'>,
  leaf: Permission,
  data?: unknown,
): Decision {
  // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
  return (permdock as DecideEither).decide(leaf, data);
}
