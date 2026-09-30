import type { Snapshot } from 'permdock';

import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  resource,
  role,
} from 'permdock';

export const permissions = definePermissions({
  post: resource({
    id: 'id',
    actions: ['read', 'update'],
    collection: ['list'],
  }),
});

const policy = definePolicy(permissions, {
  roles: [role('member', [allow(permissions.post.read)])],
  subject: (user: { readonly id: string } | null) =>
    user === null ? null : { id: user.id, roles: ['member'] },
});

export async function memberSnapshot(): Promise<Snapshot> {
  const permdock = await createPermDock(policy, { id: 'u1' });
  // SAFETY: without a signer, snapshot() returns the Snapshot object, not a signed string.
  return permdock.snapshot() as Snapshot;
}
