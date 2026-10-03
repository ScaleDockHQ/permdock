import type { Snapshot } from "permdock";

import { PermDockProvider, Protected } from "permdock/solid";
import { createComponent } from "solid-js";

import { ownPost, permissions } from "./permissions.ts";

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
        createComponent(Protected, {
          permission: permissions.post.publish,
          data: ownPost,
          fallback: "locked",
          children: "publish",
        }),
      ];
    },
  });
}
