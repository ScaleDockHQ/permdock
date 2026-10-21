import { useLayoutEffect, useMemo, useState } from "react";

import type { ProtectedActionState } from "../client/protected-action.ts";
import type { GateMode, ProtectedActionHandle } from "../client/types.ts";
import type { ProtectedAction } from "../core/action-result.ts";
import type { RowData, UncheckedData } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";

import { actionApproval, actionRunner, storeOf } from "../client/kit.ts";
import { useGate, usePermDock } from "./hooks.ts";

/**
 * A `protectAction` server action wired to a control: `gate` for the button,
 * `run(input)` and its `result`, and on an `approval-required` problem the
 * `approval` handle plus `retry()`, which resends with the token.
 */
export function useProtectedAction<T, D>(
  action: ProtectedAction<T>,
  permission: Permission,
  data?: UncheckedData<D>,
  options?: { readonly mode?: GateMode },
): ProtectedActionHandle<T>;
export function useProtectedAction<T, P extends Permission>(
  action: ProtectedAction<T>,
  permission: P,
  data?: RowData<P>,
  options?: { readonly mode?: GateMode },
): ProtectedActionHandle<T>;
export function useProtectedAction<T>(
  action: ProtectedAction<T>,
  permission: Permission,
  data?: unknown,
  options: { readonly mode?: GateMode } = {},
): ProtectedActionHandle<T> {
  const gate = useGate(permission, data, options);
  const store = storeOf(usePermDock());
  const [state, setState] = useState<ProtectedActionState<T>>({
    result: undefined,
    pending: false,
  });
  const [cell] = useState(() => {
    let current = action;
    return {
      follow: (next: ProtectedAction<T>): void => {
        current = next;
      },
      runner: actionRunner(() => current, setState),
    };
  });
  useLayoutEffect(() => {
    cell.follow(action);
  });
  const { runner } = cell;
  const approval = actionApproval(store, state.result);
  return useMemo(
    () => ({
      gate,
      result: state.result,
      pending: state.pending,
      approval,
      run: runner.run,
      retry: runner.retry,
    }),
    [gate, state, approval, runner],
  );
}
