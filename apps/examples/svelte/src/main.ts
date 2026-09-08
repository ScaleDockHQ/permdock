import { createPermDock, type Policy, type SnapshotV2 } from 'permdock';
import {
  Protected,
  getPermDock,
  permission,
  setPermDock,
} from 'permdock/svelte';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

const dock = await createPermDock(policy as Policy, memberUser);
const snapshot = await Promise.resolve(dock.snapshot());
if (typeof snapshot === 'string') {
  throw new TypeError('expected JSON snapshot');
}

export const wiring: {
  readonly snapshot: SnapshotV2;
  readonly Protected: typeof Protected;
  readonly getPermDock: typeof getPermDock;
  readonly permission: typeof permission;
  readonly setPermDock: typeof setPermDock;
  readonly ownPost: typeof ownPost;
  readonly canEdit: typeof permissions.post.update;
} = {
  snapshot,
  Protected,
  getPermDock,
  permission,
  setPermDock,
  ownPost,
  canEdit: permissions.post.update,
};
