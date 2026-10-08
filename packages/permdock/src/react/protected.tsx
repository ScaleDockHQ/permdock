import { type ReactNode, Suspense, useMemo } from "react";

import type { ProtectedProps } from "./types.ts";

import { protectedView } from "../client/views.ts";
import { usePermission, usePermDock } from "./hooks.ts";

export function Protected(props: ProtectedProps): ReactNode {
  if (props.pending === undefined) {
    return <Guard {...props} />;
  }
  return (
    <Suspense fallback={props.pending}>
      <Guard {...props} />
    </Suspense>
  );
}

function Guard(props: ProtectedProps): ReactNode {
  const root = usePermDock();
  const local = usePermission(props.permission, props.data);
  const scoped = useMemo(
    () => (props.tenant === undefined ? undefined : root.tenant(props.tenant)),
    [root, props.tenant],
  );
  const view = protectedView(local, root, props.permission, props.data, scoped);
  switch (view.slot) {
    case "pending":
      return props.pending ?? null;
    case "fallback":
      return typeof props.fallback === "function"
        ? props.fallback(view.decision)
        : (props.fallback ?? null);
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
