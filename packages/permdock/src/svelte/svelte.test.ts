import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';

import { createPermDock } from '../core/permdock.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions as defs,
  policy,
} from '../fixtures/quick-start.ts';
import { approvalHeaders } from '../react/headers.ts';
import { createSvelteStore } from './context.ts';
import { protectedView } from './protected.ts';
import {
  approvalFor,
  assignableFor,
  assignablePermissionsFor,
  filteredFor,
  membershipsFor,
  permissionFor,
  permissionsFor,
  rolesFor,
  subjectFor,
  sveltePermDock,
  tenantFor,
} from './stores.ts';

async function memberSnapshot() {
  const server = await createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error('expected JSON snapshot');
  }
  return snapshot;
}

describe('permdock/svelte', () => {
  it('answers portable grants from the snapshot without flashing deny', async () => {
    const snapshot = await memberSnapshot();
    const store = createSvelteStore({ snapshot });
    expect(protectedView(store, defs.post.update, ownPost).slot).toBe(
      'default',
    );
    expect(protectedView(store, defs.post.update, otherPost).slot).toBe(
      'fallback',
    );
    expect(
      get(permissionFor(store, defs.post.update, () => ownPost)).allowed,
    ).toBe(true);
    expect(
      get(permissionFor(store, defs.post.update, () => otherPost)).allowed,
    ).toBe(false);
  });

  it('exposes snapshot introspection through stores', async () => {
    const snapshot = await memberSnapshot();
    const store = createSvelteStore({ snapshot });
    const dock = sveltePermDock(store);
    const actions = get(
      permissionsFor(
        store,
        () => [defs.post.update, defs.post.publish],
        () => ownPost,
      ),
    );
    const editable = get(
      filteredFor(store, defs.post.update, () => [ownPost, otherPost]),
    );
    const tenant = get(tenantFor(store));
    const memberships = get(membershipsFor(store));
    const roles = get(rolesFor(store));
    const subject = get(subjectFor(store));
    const canEdit = get(permissionFor(store, defs.post.update, () => ownPost));
    expect(
      `${canEdit.allowed}:${actions.granted.length}:${editable.length}:${editable.partial}:${tenant.tenant ?? 'none'}:${memberships.length}:${roles.roles.map((item) => item.key).join(',')}:${subject.simulated}:${dock.status()}`,
    ).toContain('true:1:1:false');
    expect(roles.roles.map((item) => item.key)).toContain('member');
    expect(subject.simulated).toBe(false);
    expect(dock.status()).toBe('ready');
    expect(get(assignableFor(store))).toEqual([]);
    expect(get(assignablePermissionsFor(store))).toEqual([]);
    expect(get(approvalFor(store, () => canEdit.decision)).state).toBe(
      'not-needed',
    );
  });

  it('builds the approval resume header', () => {
    expect(approvalHeaders('pd1.abc')).toEqual({
      'PermDock-Approval': 'pd1.abc',
    });
  });
});
