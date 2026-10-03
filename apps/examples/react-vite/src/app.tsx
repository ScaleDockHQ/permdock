import type { Snapshot } from "permdock";

import { PermDockProvider, Protected } from "permdock/react";

import { ownPost, permissions } from "./permissions.ts";

export function App(props: { readonly snapshot: Snapshot }) {
  return (
    <PermDockProvider snapshot={props.snapshot}>
      <Protected
        permission={permissions.post.update}
        data={ownPost}
        fallback={<span>locked</span>}
      >
        <span>edit</span>
      </Protected>
      <Protected
        permission={permissions.post.publish}
        data={ownPost}
        fallback={<span>locked</span>}
      >
        <span>publish</span>
      </Protected>
    </PermDockProvider>
  );
}
