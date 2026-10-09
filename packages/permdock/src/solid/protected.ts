import { createMemo, type JSX } from "solid-js";

import type { SolidChild } from "./types.ts";
import type { ProtectedProps } from "./types.ts";

import { protectedView, scopedTenant } from "../client/views.ts";
import { usePermission, usePermDock } from "./hooks.ts";

export function Protected(props: ProtectedProps): JSX.Element {
  const root = usePermDock();
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
        return props.pending ?? null;
      case "fallback":
        return typeof props.fallback === "function"
          ? props.fallback(current.decision)
          : (props.fallback ?? null);
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
