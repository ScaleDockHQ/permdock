import { createMemo, type JSX } from "solid-js";

import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";
import type { SolidChild } from "./types.ts";
import type { ClientStatus, ProtectedProps } from "./types.ts";

import { usePermission, usePermDock } from "./hooks.ts";

type DecidePermDock = {
  readonly decide: (permission: Permission, data?: unknown) => Decision;
};

type ScopedView = {
  readonly allowed: boolean;
  readonly status: ClientStatus;
  readonly decision: Decision;
};

export function Protected(props: ProtectedProps): JSX.Element {
  const root = usePermDock();
  const local = usePermission(
    () => props.permission,
    () => props.data,
  );
  const view = createMemo((): ScopedView => {
    if (props.tenant === undefined) {
      return local();
    }
    // SAFETY: decide's instance and collection overloads share one implementation that takes either kind.
    return tenantView(
      root.tenant(props.tenant) as DecidePermDock,
      props.permission,
      props.data,
    );
  });
  const render = (): SolidChild => {
    const scoped = view();
    if (scoped.status === "pending") {
      return props.pending ?? null;
    }
    if (!scoped.allowed || scoped.decision.outcome !== "granted") {
      if (typeof props.fallback === "function") {
        return props.fallback(scoped.decision);
      }
      return props.fallback ?? null;
    }
    if (typeof props.children === "function") {
      return props.children(scoped.decision);
    }
    return props.children;
  };
  // SAFETY: Solid renders an accessor child reactively; its JSX types only name nodes.
  return render as unknown as JSX.Element;
}

function tenantView(
  permdock: DecidePermDock,
  permission: Permission,
  data: unknown,
): ScopedView {
  const decision = permdock.decide(permission, data);
  return {
    allowed: decision.outcome === "granted",
    status: "ready",
    decision,
  };
}
