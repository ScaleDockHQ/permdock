import {
  Suspense,
  createComponent,
  createResource,
  createSignal,
} from 'solid-js';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';

import type { Snapshot } from '../../src/core/interfaces.ts';
import type { Permission } from '../../src/core/permissions.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import { usePermDock } from '../../src/solid/hooks.ts';
import { Protected } from '../../src/solid/protected.ts';
import { PermDockProvider } from '../../src/solid/provider.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

async function snapshotOf(user: typeof memberUser): Promise<Snapshot> {
  const server = await createPermDock(policy as never, user);
  return server.snapshot() as Snapshot;
}

function ignore(): void {
  return undefined;
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function mountProtected(
  snapshot: Parameters<typeof PermDockProvider>[0]['snapshot'],
  permission: () => Permission,
  data: () => unknown,
): { readonly root: HTMLElement; readonly dispose: () => void } {
  const root = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = 'granted';
  const dispose = render(
    () =>
      createComponent(PermDockProvider, {
        snapshot,
        get children() {
          return createComponent(Protected, {
            get permission() {
              return permission();
            },
            get data() {
              return data();
            },
            pending: 'pending',
            fallback: 'denied',
            children: strong,
          });
        },
      }),
    root,
  );
  return { root, dispose };
}

describe('permdock/solid (browser build)', () => {
  it('<Protected> follows a changed permission and accepts element children', async () => {
    const [permission, setPermission] = createSignal<Permission>(
      permissions.post.update,
    );
    const [data, setData] = createSignal<unknown>(ownPost);
    const view = mountProtected(await snapshotOf(memberUser), permission, data);
    expect(view.root.innerHTML).toBe('<strong>granted</strong>');
    setPermission(permissions.post.delete);
    expect(view.root.textContent).toBe('denied');
    setPermission(permissions.post.update);
    setData(otherPost);
    expect(view.root.textContent).toBe('denied');
    view.dispose();
  });

  it('re-hydrates from a snapshot accessor', async () => {
    const [snapshot, setSnapshot] = createSignal<Snapshot>(
      await snapshotOf(memberUser),
    );
    const admin = await snapshotOf(adminUser);
    let dock: ReturnType<typeof usePermDock> | undefined;
    const root = document.createElement('div');
    const dispose = render(
      () =>
        createComponent(PermDockProvider, {
          snapshot,
          get children() {
            dock = usePermDock();
            return '';
          },
        }),
      root,
    );
    expect(dock?.subject.principal?.id).toBe('u1');
    setSnapshot(admin);
    expect(dock?.subject.principal?.id).toBe('u2');
    dispose();
  });

  it('stays pending while a createResource snapshot loads', async () => {
    const snapshot = await snapshotOf(memberUser);
    let release: (value: Snapshot) => void = ignore;
    const root = document.createElement('div');
    let view:
      | { readonly root: HTMLElement; readonly dispose: () => void }
      | undefined;
    const dispose = render(() => {
      const [resource] = createResource(
        () =>
          new Promise<Snapshot>((resolve) => {
            release = resolve;
          }),
      );
      view = mountProtected(
        () => resource(),
        () => permissions.post.update,
        () => ownPost,
      );
      return '';
    }, root);
    expect(view?.root.textContent).toBe('pending');
    release(snapshot);
    await flush();
    expect(view?.root.textContent).toBe('granted');
    view?.dispose();
    dispose();
  });

  it('stays pending until a snapshot promise settles', async () => {
    const promise = snapshotOf(memberUser);
    const view = mountProtected(
      promise,
      () => permissions.post.update,
      () => ownPost,
    );
    expect(view.root.textContent).toBe('pending');
    await promise;
    await flush();
    expect(view.root.textContent).toBe('granted');
    view.dispose();
  });

  it('hydrates the store while a sibling keeps the boundary suspended', async () => {
    const snapshot = await snapshotOf(memberUser);
    let release: (value: Snapshot) => void = ignore;
    let dock: ReturnType<typeof usePermDock> | undefined;
    const root = document.createElement('div');
    const dispose = render(() => {
      const [resource] = createResource(
        () =>
          new Promise<Snapshot>((resolve) => {
            release = resolve;
          }),
      );
      const [never] = createResource(() => new Promise<string>(ignore));
      return createComponent(Suspense, {
        fallback: 'loading',
        get children() {
          return createComponent(PermDockProvider, {
            snapshot: () => resource(),
            get children() {
              dock = usePermDock();
              return () => never();
            },
          });
        },
      });
    }, root);
    release(snapshot);
    await flush();
    expect(root.textContent).toBe('loading');
    expect(dock?.subject.principal?.id).toBe('u1');
    dispose();
  });
});
