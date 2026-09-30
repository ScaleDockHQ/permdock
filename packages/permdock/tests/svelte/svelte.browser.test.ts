import { flushSync, mount, unmount } from 'svelte';
import { get, writable } from 'svelte/store';
import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../../src/core/interfaces.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import { createSvelteStore } from '../../src/svelte/context.ts';
import {
  filteredFor,
  permissionFor,
  subjectFor,
} from '../../src/svelte/stores.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions as defs,
  policy,
} from '../fixtures/quick-start.ts';
import { cell, reactive } from './fixtures/cell.svelte.ts';
import Harness from './Harness.test.svelte';

async function snapshotOf(user: typeof memberUser): Promise<Snapshot> {
  // SAFETY: user is a quick-start user fixture; only the policy generic is erased.
  const server = await createPermDock(policy as never, user);
  // SAFETY: snapshot() returns a Snapshot; the erased generic above hides its type.
  return server.snapshot() as Snapshot;
}

function latest<T>(readable: {
  subscribe(run: (value: T) => void): () => void;
}): {
  readonly value: () => T;
  readonly stop: () => void;
} {
  let current: T | undefined;
  const stop = readable.subscribe((value) => {
    current = value;
  });
  // SAFETY: a Svelte store calls run synchronously on subscribe, so current is set.
  return { value: () => current as T, stop };
}

describe('permdock/svelte (browser build)', () => {
  it('recomputes permission when its data getter reads changed state', async () => {
    const store = createSvelteStore({ snapshot: await snapshotOf(memberUser) });
    const post = cell<unknown>(ownPost);
    const view = latest(
      permissionFor(store, defs.post.update, () => post.value),
    );
    expect(view.value().allowed).toBe(true);
    post.value = otherPost;
    flushSync();
    expect(view.value().allowed).toBe(false);
    view.stop();
  });

  it('recomputes filtered when its rows getter reads changed state', async () => {
    const store = createSvelteStore({ snapshot: await snapshotOf(memberUser) });
    const rows = cell([otherPost]);
    const view = latest(filteredFor(store, defs.post.update, () => rows.value));
    expect(view.value()).toHaveLength(0);
    rows.value = [ownPost, otherPost];
    flushSync();
    expect(view.value()).toHaveLength(1);
    view.stop();
  });

  it('re-hydrates from a snapshot getter', async () => {
    const member = await snapshotOf(memberUser);
    const admin = await snapshotOf(adminUser);
    const source = cell<Snapshot>(member);
    const store = createSvelteStore({ snapshot: () => source.value });
    const view = latest(subjectFor(store));
    expect(view.value().principal?.id).toBe('u1');
    source.value = admin;
    flushSync();
    expect(view.value().principal?.id).toBe('u2');
    view.stop();
  });

  it('re-hydrates from a readable store', async () => {
    const source = writable<Snapshot>(await snapshotOf(memberUser));
    const store = createSvelteStore({ snapshot: source });
    expect(store.get().subject.principal?.id).toBe('u1');
    source.set(await snapshotOf(adminUser));
    expect(store.get().subject.principal?.id).toBe('u2');
  });

  it('stays pending until a snapshot promise settles', async () => {
    const snapshot = await snapshotOf(memberUser);
    const promise = Promise.resolve(snapshot);
    const store = createSvelteStore({ snapshot: promise });
    expect(store.get().status()).toBe('pending');
    await promise;
    await Promise.resolve();
    expect(store.get().status()).toBe('ready');
    expect(
      get(permissionFor(store, defs.post.update, () => ownPost)).allowed,
    ).toBe(true);
  });

  it('<Protected> follows a changed permission prop', async () => {
    const target = document.createElement('div');
    // SAFETY: widens data to unknown, the prop type of the Harness component.
    const props = reactive({
      snapshot: await snapshotOf(memberUser),
      permission: defs.post.update,
      data: ownPost as unknown,
    });
    const app = mount(Harness, { target, props });
    flushSync();
    expect(target.textContent).toBe('granted');
    props.permission = defs.post.delete;
    flushSync();
    expect(target.textContent).toBe('denied');
    props.permission = defs.post.update;
    props.data = otherPost;
    flushSync();
    expect(target.textContent).toBe('denied');
    await unmount(app);
  });

  it('<Protected> renders pending until a snapshot promise settles', async () => {
    const target = document.createElement('div');
    const promise = snapshotOf(memberUser);
    const app = mount(Harness, {
      target,
      props: { snapshot: promise, permission: defs.post.update, data: ownPost },
    });
    flushSync();
    expect(target.textContent).toBe('pending');
    await promise;
    await Promise.resolve();
    flushSync();
    expect(target.textContent).toBe('granted');
    await unmount(app);
  });
});
