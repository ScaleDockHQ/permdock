import type { Snapshot } from "permdock";

import {
  PermDockProvider,
  PermissionBoundary,
  Protected,
  usePermDock,
  usePermission,
} from "permdock/solid";
import { createComponent, createRenderEffect, type JSX } from "solid-js";

import { ownPost, permissions } from "./permissions.ts";

function DeleteLabel(): JSX.Element {
  const state = usePermission(permissions.post.delete, () => ownPost);
  const label = document.createTextNode("");
  createRenderEffect(() => {
    const current = state();
    if (current.allowed) {
      label.data = "delete";
    } else {
      label.data =
        current.decision.outcome === "approval-required"
          ? "ask to delete"
          : "locked";
    }
  });
  return label;
}

function PublishPanel(): JSX.Element {
  usePermDock().assert(permissions.post.publish, ownPost);
  return "publish panel";
}

export function App(props: { readonly snapshot: Snapshot }) {
  return createComponent(PermDockProvider, {
    get snapshot() {
      return props.snapshot;
    },
    get children() {
      return [
        createComponent(Protected, {
          permission: permissions.post.update,
          data: ownPost,
          fallback: "locked",
          children: "edit",
        }),
        " ",
        createComponent(DeleteLabel, {}),
        " ",
        createComponent(PermissionBoundary, {
          denied: (refused) => `no ${refused.permission}`,
          get children() {
            return createComponent(PublishPanel, {});
          },
        }),
      ];
    },
  });
}
