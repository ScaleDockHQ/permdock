import type { Snapshot } from 'permdock';

import { PermDockProvider, Protected } from 'permdock/solid';
import { createComponent } from 'solid-js';

import { ownPost, permissions } from './permissions.ts';

export function App(props: { readonly snapshot: Snapshot }) {
  return createComponent(PermDockProvider as never, {
    get snapshot() {
      return props.snapshot;
    },
    get children() {
      return [
        createComponent(Protected as never, {
          permission: permissions.post.update,
          data: ownPost,
          fallback: 'locked',
          children: 'edit',
        }),
        ' ',
        createComponent(Protected as never, {
          permission: permissions.post.publish,
          data: ownPost,
          fallback: 'locked',
          children: 'publish',
        }),
      ];
    },
  });
}
