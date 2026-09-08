import type { SnapshotV2 } from 'permdock';

import { PermDockProvider, Protected } from 'permdock/solid';
import { createComponent } from 'solid-js';

import { ownPost, permissions } from './permissions.ts';

export function App(props: { readonly snapshot: SnapshotV2 }) {
  return createComponent(PermDockProvider, {
    get snapshot() {
      return props.snapshot;
    },
    get children() {
      return createComponent(Protected, {
        permission: permissions.post.update,
        data: ownPost,
        fallback: 'locked',
        children: 'edit',
      });
    },
  });
}
