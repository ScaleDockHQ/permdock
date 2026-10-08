import type { Snapshot } from "permdock";

import { PermDockProvider, Protected, usePermission } from "permdock/react";

import { ownPost, permissions } from "./permissions.ts";

function DeleteButton() {
  const { allowed, decision } = usePermission(permissions.post.delete, ownPost);
  if (allowed) {
    return <button type="button">delete</button>;
  }
  return (
    <span>
      {decision.outcome === "approval-required" ? "ask to delete" : "locked"}
    </span>
  );
}

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
      <DeleteButton />
    </PermDockProvider>
  );
}
