import type { Decision, Denial } from "../decision.ts";
import type { Membership } from "../subject.ts";
import type { EvaluationCall, EvaluationState } from "./state.ts";

import { alternativesFor } from "../evaluation-alternatives.ts";
import { traceOf } from "../evaluation-trace.ts";
import { finish } from "../events.ts";
import { freezeDeep } from "../freeze.ts";

/**
 * Every exit of `evaluate`: names the permission, freezes, attaches the trace
 * and emits.
 */
export function complete(
  call: EvaluationCall & { readonly current: unknown },
  raw: Decision,
  membership?: Membership,
): Decision {
  const { env, permission, tracer } = call;
  const decision: Decision =
    env.outcomeOnly !== true &&
    raw.outcome === "denied" &&
    raw.permission === undefined
      ? { ...raw, permission: permission.key }
      : raw;
  const final: Decision =
    env.outcomeOnly === true
      ? decision
      : freezeDeep(
          tracer === undefined
            ? decision
            : { ...decision, trace: traceOf(tracer) },
        );
  finish(
    call.policy,
    call.given,
    permission,
    call.current,
    final,
    call.options,
    env,
    call.options.trusted === true,
    membership,
  );
  return final;
}

export function deniedNow(
  call: EvaluationCall & { readonly current: unknown },
  denial: Denial,
): Decision {
  return complete(call, {
    outcome: "denied",
    denials: [denial],
    alternatives: [],
  });
}

export function deniedWithAlternatives(
  state: EvaluationState,
  denials: readonly Denial[],
): Decision {
  return complete(state, {
    outcome: "denied",
    denials,
    alternatives: state.env.skipAlternatives
      ? []
      : alternativesFor(
          state.evaluate,
          state.policy,
          state.permission,
          state.subject,
          state.now,
          state.env,
        ),
  });
}
