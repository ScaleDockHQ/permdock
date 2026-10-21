import type { ActionResult, ProtectedAction } from "../core/action-result.ts";
import type { ApprovalRequiredDecision } from "../core/decision.ts";
import type { ClientStore } from "./store.ts";
import type { ApprovalHandle } from "./types.ts";

import { problemType } from "../core/problem-types.ts";
import { approvalHandle } from "./views.ts";

export type ProtectedActionState<T> = {
  /** The last call's answer; `undefined` before the first call. */
  readonly result: ActionResult<T> | undefined;
  /** A call is in flight. */
  readonly pending: boolean;
};

export type ActionRunner<T> = {
  readonly run: (input: unknown) => Promise<ActionResult<T>>;
  /**
   * Resends the last input with the token of the last `approval-required`
   * problem; `undefined` without one.
   */
  readonly retry: () => Promise<ActionResult<T> | undefined>;
};

function approvalToken(
  result: ActionResult<unknown> | undefined,
): string | undefined {
  return result === undefined ||
    result.ok ||
    result.problem.type !== problemType("approval-required")
    ? undefined
    : result.problem.token;
}

/**
 * Calls a protected server action and reports its state through `set`. Only the
 * latest call's answer lands; a throw (a Next.js redirect, a network failure)
 * clears `pending` and propagates.
 */
export function actionRunner<T>(
  read: () => ProtectedAction<T>,
  set: (state: ProtectedActionState<T>) => void,
): ActionRunner<T> {
  let result: ActionResult<T> | undefined;
  let last: { readonly input: unknown } | undefined;
  let seq = 0;
  const call = async (
    input: unknown,
    options: { readonly approval?: string } | undefined,
  ): Promise<ActionResult<T>> => {
    seq += 1;
    const mine = seq;
    last = { input };
    set({ result, pending: true });
    try {
      const next = await read()(input, options);
      if (mine === seq) {
        result = next;
        set({ result, pending: false });
      }
      return next;
    } catch (error) {
      if (mine === seq) {
        set({ result, pending: false });
      }
      throw error;
    }
  };
  return {
    run: (input) => call(input, undefined),
    retry: () => {
      const token = approvalToken(result);
      return last === undefined || token === undefined
        ? Promise.resolve(undefined)
        : call(last.input, { approval: token });
    },
  };
}

/**
 * The approval handle for an `approval-required` problem; `undefined` for any
 * other result. The decision is rebuilt from the problem only to poll and
 * request its token: the server decides again on `retry`.
 */
export function actionApproval(
  store: ClientStore,
  result: ActionResult<unknown> | undefined,
): ApprovalHandle | undefined {
  const token = approvalToken(result);
  const permission =
    result === undefined || result.ok ? undefined : result.problem.permission;
  if (token === undefined || permission === undefined) {
    return undefined;
  }
  const decision: ApprovalRequiredDecision = {
    outcome: "approval-required",
    grant: { role: null, permission },
    reason: "human",
    token,
  };
  return approvalHandle(store, decision);
}
