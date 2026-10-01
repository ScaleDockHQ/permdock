import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PermDockStorage } from '../../src/react-native/types.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import { PermDockProvider } from '../../src/react-native/provider.tsx';
import {
  acceptSnapshot,
  clearStorage,
  memoryStorage,
  persistSnapshot,
  readStored,
  readStoredSync,
  SNAPSHOT_KEY,
} from '../../src/react-native/storage.ts';
import { createNativeStore } from '../../src/react-native/store.ts';
import { usePermission } from '../../src/react/hooks.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

async function memberSnapshot() {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
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

type AsyncStorage = PermDockStorage & {
  readonly writes: string[];
  readonly map: Map<string, string>;
};

/** An AsyncStorage-like store whose writes and removes reject. */
function asyncStorage(
  initial: Readonly<Record<string, string>> = {},
): AsyncStorage {
  const map = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    map,
    writes,
    getItem: async (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      map.set(key, value);
      return Promise.reject(new Error('quota'));
    },
    removeItem: (key) => {
      writes.push(`-${key}`);
      map.delete(key);
      return Promise.reject(new Error('locked'));
    },
  };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
}

describe('permdock/react-native storage', () => {
  it('accepts only a parseable snapshot for the expected subject', async () => {
    const snapshot = await memberSnapshot();
    const raw = JSON.stringify(snapshot);
    expect(acceptSnapshot(null, undefined)).toBeUndefined();
    expect(acceptSnapshot('', undefined)).toBeUndefined();
    expect(acceptSnapshot('{not json', undefined)).toBeUndefined();
    expect(acceptSnapshot('{"v":99}', undefined)).toBeUndefined();
    expect(acceptSnapshot(raw, 'someone-else')).toBeUndefined();
    expect(acceptSnapshot(raw, 'u1')?.subject.principal?.id).toBe('u1');
    expect(acceptSnapshot(raw, undefined)?.subject.principal?.id).toBe('u1');
  });

  it('reads sync storage directly and defers async storage', async () => {
    const snapshot = await memberSnapshot();
    const values = {
      [SNAPSHOT_KEY]: JSON.stringify(snapshot),
      'permdock.tenant': 'o1',
    };
    expect(readStoredSync(memoryStorage(values), undefined)).toMatchObject({
      tenant: 'o1',
    });
    expect(
      readStoredSync(memoryStorage({ 'permdock.tenant': '' }), undefined),
    ).toEqual({ snapshot: undefined, tenant: undefined });
    expect(readStoredSync(asyncStorage(values), undefined)).toBeUndefined();
    const stored = await readStored(asyncStorage(values), 'u1');
    expect(stored.tenant).toBe('o1');
    expect(stored.snapshot?.subject.principal?.id).toBe('u1');
    expect(await readStored(asyncStorage(), undefined)).toEqual({
      snapshot: undefined,
      tenant: undefined,
    });
  });

  it('persists and clears through storage that rejects without throwing', async () => {
    const snapshot = await memberSnapshot();
    const storage = asyncStorage();
    persistSnapshot(storage, snapshot, undefined);
    persistSnapshot(storage, snapshot, 'o1');
    clearStorage(storage);
    await settle();
    expect(storage.writes).toEqual([
      SNAPSHOT_KEY,
      SNAPSHOT_KEY,
      'permdock.tenant',
      `-${SNAPSHOT_KEY}`,
      '-permdock.tenant',
    ]);
    const sync = memoryStorage();
    persistSnapshot(sync, snapshot, 'o1');
    expect(sync.getItem('permdock.tenant')).toBe('o1');
    clearStorage(sync);
    expect(sync.getItem(SNAPSHOT_KEY)).toBeNull();
  });
});

describe('permdock/react-native createNativeStore', () => {
  it('seeds from a snapshot string or object and persists it with the tenant', async () => {
    const snapshot = await memberSnapshot();
    const fromString = memoryStorage();
    const seeded = createNativeStore({
      storage: fromString,
      snapshot: JSON.stringify(snapshot),
      tenant: 'o1',
    });
    expect(
      seeded.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    expect(fromString.getItem(SNAPSHOT_KEY)).toBe(JSON.stringify(snapshot));
    expect(fromString.getItem('permdock.tenant')).toBe('o1');
    const fromObject = memoryStorage();
    createNativeStore({ storage: fromObject, snapshot });
    expect(fromObject.getItem(SNAPSHOT_KEY)).toBe(JSON.stringify(snapshot));
  });

  it('verifies a signed snapshot and never reads storage for it', async () => {
    const snapshot = await memberSnapshot();
    const storage = asyncStorage();
    const store = createNativeStore({
      storage,
      snapshot: 'a.b.c',
      verifier: {
        verify: async () => ({
          ok: true,
          claims: { snapshot },
          header: { alg: 'ES256' },
        }),
      },
    });
    expect(store.get().status()).toBe('pending');
    await settle();
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    expect(storage.writes).toEqual([SNAPSHOT_KEY]);
  });

  it('hydrates from async storage after launch', async () => {
    const snapshot = await memberSnapshot();
    const storage = asyncStorage({ [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
    const store = createNativeStore({ storage });
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
    await settle();
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
  });

  it('ignores the async read once the store was cleared or hydrated', async () => {
    const snapshot = await memberSnapshot();
    const storage = asyncStorage({ [SNAPSHOT_KEY]: JSON.stringify(snapshot) });
    const store = createNativeStore({ storage });
    store.get().clear();
    await settle();
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(false);
    const empty = createNativeStore({ storage: asyncStorage() });
    await settle();
    expect(empty.get().subject.principal).toBeNull();
  });
});

function Probe(): string {
  const { allowed } = usePermission(permissions.post.update, ownPost);
  return allowed ? 'allowed' : 'denied';
}
