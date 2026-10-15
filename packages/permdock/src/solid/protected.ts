import { createMemo, useContext, type JSX } from "solid-js";

import type { ApprovalRequiredDecision, Decision } from "../core/decision.ts";
import type { ProtectedProps, SolidChild } from "./types.ts";

import { protectedView, scopedTenant, slotContent } from "../client/views.ts";
import { PermDockUiContext } from "./context.ts";
import { usePermission, usePermDock } from "./hooks.ts";

export function Protected(props: ProtectedProps): JSX.Element {
  const root = usePermDock();
  const ui = useContext(PermDockUiContext);
  const local = usePermission(
    () => props.permission,
    () => props.data,
  );
  const scoped = createMemo(() => scopedTenant(root, props.tenant));
  const view = createMemo(() =>
    protectedView(local(), root, props.permission, props.data, scoped()),
  );
  const render = (): SolidChild => {
    const current = view();
    switch (current.slot) {
      case "pending":
        return slotContent("pending", props, ui.defaults) ?? null;
      case "denied":
        return content(
          slotContent("denied", props, ui.defaults),
          current.decision,
        );
      case "approval":
        return content<ApprovalRequiredDecision>(
          slotContent("approval", props, ui.defaults),
          current.decision,
        );
      case "default":
        return typeof props.children === "function"
          ? props.children(current.decision)
          : props.children;
      default: {
        const exhausted: never = current;
        return exhausted;
      }
    }
  };
  // SAFETY: Solid renders an accessor child reactively; its JSX types only name nodes.
  return render as unknown as JSX.Element;
}

function content<D extends Decision>(
  slot: SolidChild | ((decision: D) => SolidChild),
  decision: D,
): SolidChild {
  return typeof slot === "function" ? slot(decision) : (slot ?? null);
}
