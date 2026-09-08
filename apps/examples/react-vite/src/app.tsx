import type { SnapshotV2 } from 'permdock';

import { PermDockProvider, Protected } from 'permdock/react';

import { ownPost, permissions } from './permissions.ts';

export function App(props: { readonly snapshot: SnapshotV2 }) {
  return (
    <PermDockProvider snapshot={props.snapshot}>
      <Protected
        permission={permissions.post.update}
        data={ownPost}
        fallback="locked"
      >
        edit
      </Protected>
    </PermDockProvider>
  );
}
