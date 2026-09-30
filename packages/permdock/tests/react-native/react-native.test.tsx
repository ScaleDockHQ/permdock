import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createPermDock } from '../../src/core/permdock.ts';
import { PermDockProvider } from '../../src/react-native/provider.tsx';
import { memoryStorage, SNAPSHOT_KEY } from '../../src/react-native/storage.ts';
import { createNativeStore } from '../../src/react-native/store.ts';
import { usePermission } from '../../src/react/hooks.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

async function memberSnapshot() {
  const server = await createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error('expected JSON snapshot');
  }
  return snapshot;
}

describe('permdock/react-native', () => {
  it('answers portable grants from sync storage on the first frame', async () => {
    const snapshot = await memberSnapshot();
    const storage = memoryStorage({
      [SNAPSHOT_KEY]: JSON.stringify(snapshot),
    });
    const html = renderToStaticMarkup(
      <PermDockProvider storage={storage}>
        <Probe />
      </PermDockProvider>,
    );
    expect(html).toContain('allowed');
  });

  it('discards a persisted snapshot for a different subject', async () => {
    const snapshot = await memberSnapshot();
    const storage = memoryStorage({
      [SNAPSHOT_KEY]: JSON.stringify(snapshot),
    });
    const store = createNativeStore({
      storage,
      subjectId: 'other-user',
    });
    const state = store.permissionState(permissions.post.update, ownPost);
    expect(state.allowed).toBe(false);
  });

  it('clears persisted grants so the next launch is empty', async () => {
    const snapshot = await memberSnapshot();
    const storage = memoryStorage({
      [SNAPSHOT_KEY]: JSON.stringify(snapshot),
    });
    const store = createNativeStore({ storage });
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    store.get().clear();
    expect(storage.getItem(SNAPSHOT_KEY)).toBeNull();
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
  });

  it('writes a fetched snapshot back to storage', async () => {
    const snapshot = await memberSnapshot();
    const storage = memoryStorage();
    const store = createNativeStore({
      storage,
      snapshotUrl: 'https://api.example.com/permdock/snapshot',
      fetch: async () =>
        new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await store.get().refresh();
    const raw = storage.getItem(SNAPSHOT_KEY);
    expect(typeof raw).toBe('string');
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
  });
});

function Probe(): string {
  const { allowed } = usePermission(permissions.post.update, ownPost);
  return allowed ? 'allowed' : 'denied';
}
