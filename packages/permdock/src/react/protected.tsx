import { type ReactNode, Suspense, use, useMemo } from "react";

import type { ApprovalRequiredDecision, Decision } from "../core/decision.ts";
import type { ProtectedProps } from "./types.ts";

import { protectedView, scopedTenant, slotContent } from "../client/views.ts";
import { PermDockUiContext } from "./context.ts";
import { usePermission, usePermDock } from "./hooks.ts";

export function Protected(props: ProtectedProps): ReactNode {
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
  const root = usePermDock();
  const local = usePermission(props.permission, props.data);
  const scoped = useMemo(
    () => scopedTenant(root, props.tenant),
    [root, props.tenant],
  );
  const view = protectedView(local, root, props.permission, props.data, scoped);
  switch (view.slot) {
    case "pending":
      return slotContent("pending", props, defaults) ?? null;
    case "fallback":
      return render(slotContent("fallback", props, defaults), view.decision);
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
