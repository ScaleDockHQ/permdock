import type { Decision } from '../../src/index.ts';

/** The first denial reason of a denied decision; `undefined` for any other outcome. */
export function reasonOf(decision: Decision): string | undefined {
  return decision.outcome === 'denied'
    ? decision.denials[0]?.reason
    : undefined;
}
