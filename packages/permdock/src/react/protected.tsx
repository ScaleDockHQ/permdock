import type { ContextType, ReactNode } from "react";

import { Suspense, use, useMemo } from "react";

import type { ApprovalRequiredDecision, Decision } from "../core/decision.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PermissionOutcome, ProtectedProps } from "./types.ts";

import {
  protectedView,
  scopedTenant,
  slotContent,
  storeOf,
} from "../client/kit.ts";
import { PermDockUiContext } from "./context.ts";
import { useDecision, usePermDock, useSnapshotPermDock } from "./hooks.ts";

export function Protected<P extends Permission>(
  props: ProtectedProps<P>,
): ReactNode {
  const { defaults } = use(PermDockUiContext);
  const pending = slotContent("pending", props, defaults);
  if (pending === undefined) {
    return <Guard {...props} />;
  }
  return (
    <Suspense fallback={pending}>
      <Guard {...props} />
    </Suspense>
  );
}

function Guard(props: ProtectedProps): ReactNode {
  const { defaults } = use(PermDockUiContext);
  const store = storeOf(useSnapshotPermDock());
  const quick =
    props.data === undefined && props.tenant === undefined
      ? store.quick(props.permission)
      : undefined;
  if (quick !== undefined) {
    // Content that is a function receives a `Decision`, which only the evaluator builds.
    const fast = quickContent(quick, props, defaults);
    if (fast !== undefined) {
      return fast;
    }
  }
  return <DecidedGuard {...props} />;
}

function isRender(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === "function";
}

function quickContent(
  quick: PermissionOutcome,
  props: ProtectedProps,
  defaults: ContextType<typeof PermDockUiContext>["defaults"],
): ReactNode | undefined {
  if (quick.status === "pending") {
    return slotContent("pending", props, defaults) ?? null;
  }
  switch (quick.outcome) {
    case "granted":
      return isRender(props.children) ? undefined : (props.children ?? null);
    case "approval-required": {
      const content = slotContent("approval", props, defaults);
      return isRender(content) ? undefined : (content ?? null);
    }
    case "denied": {
      const content = slotContent("denied", props, defaults);
      return isRender(content) ? undefined : (content ?? null);
    }
    default: {
      const exhausted: never = quick.outcome;
      return exhausted;
    }
  }
}

function DecidedGuard(props: ProtectedProps): ReactNode {
  const { defaults } = use(PermDockUiContext);
  const root = usePermDock();
  const local = useDecision(props.permission, props.data);
  const scoped = useMemo(
    () => scopedTenant(root, props.tenant),
    [root, props.tenant],
  );
  const view = protectedView(local, root, props.permission, props.data, scoped);
  switch (view.slot) {
    case "pending":
      return slotContent("pending", props, defaults) ?? null;
    case "denied":
      return render(slotContent("denied", props, defaults), view.decision);
    case "approval":
      return render<ApprovalRequiredDecision>(
        slotContent("approval", props, defaults),
        view.decision,
      );
    case "default":
      return typeof props.children === "function"
        ? props.children(view.decision)
        : props.children;
    default: {
      const exhausted: never = view;
      return exhausted;
    }
  }
}

function render<D extends Decision>(
  content: ReactNode | ((decision: D) => ReactNode),
  decision: D,
): ReactNode {
  return typeof content === "function" ? content(decision) : (content ?? null);
}
