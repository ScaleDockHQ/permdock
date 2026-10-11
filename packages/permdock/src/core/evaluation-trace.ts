import type {
  MatchedGrant,
  Trace,
  TraceSkip,
  TraceSkipReason,
} from "./decision.ts";
import type { Grant } from "./policy-types.ts";

/**
 * Collects the trace for `explain`. Absent (undefined) on a plain `decide`,
 * so a check without `explain` allocates nothing for it.
 */
export type Tracer = {
  evaluated: number;
  readonly allows: MatchedGrant[];
  readonly denies: MatchedGrant[];
  readonly skipped: TraceSkip[];
};

export function skip(
  tracer: Tracer | undefined,
  grant: Grant,
  permissionKey: string,
  why: TraceSkipReason,
): void {
  tracer?.skipped.push({
    role: grant.role,
    permission: permissionKey,
    effect: grant.effect,
    why,
  });
}

export function traceOf(tracer: Tracer): Trace {
  return {
    evaluated: tracer.evaluated,
    allows: tracer.allows,
    denies: tracer.denies,
    skipped: tracer.skipped,
  };
}
