import { describe, expect, it } from 'vitest';
import {
  createApp,
  defineAsyncComponent,
  defineComponent,
  h,
  nextTick,
  ref,
  shallowRef,
  Suspense,
} from 'vue';

import type { Snapshot } from '../../src/core/interfaces.ts';
import type { Permission } from '../../src/core/permissions.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import { usePermDock } from '../../src/vue/composables.ts';
import { permdockPlugin } from '../../src/vue/plugin.ts';
import { Protected } from '../../src/vue/protected.ts';
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

function guarded(
  permission: () => Permission,
  data: () => unknown,
): ReturnType<typeof defineComponent> {
  return defineComponent({
    setup() {
      return () =>
        h(
          Protected,
          { permission: permission(), data: data() },
          {
            default: () => h('b', 'granted'),
            fallback: () => h('i', 'denied'),
            pending: () => h('u', 'pending'),
          },
        );
    },
  });
}

describe('permdock/vue (browser build)', () => {
  it('<Protected> follows a changed permission prop', async () => {
    const permission = shallowRef<Permission>(permissions.post.update);
    const data = shallowRef<unknown>(ownPost);
    const root = document.createElement('div');
    const app = createApp(
      guarded(
        () => permission.value,
        () => data.value,
      ),
    );
    app.use(permdockPlugin, { snapshot: await snapshotOf(memberUser) });
    app.mount(root);
    expect(root.textContent).toBe('granted');
    permission.value = permissions.post.delete;
    await nextTick();
    expect(root.textContent).toBe('denied');
    permission.value = permissions.post.update;
    data.value = otherPost;
    await nextTick();
    expect(root.textContent).toBe('denied');
    app.unmount();
  });

  it('re-hydrates from a snapshot ref', async () => {
    const snapshot = ref<Snapshot>(await snapshotOf(memberUser));
    const admin = await snapshotOf(adminUser);
    let dock: ReturnType<typeof usePermDock> | undefined;
    const app = createApp(
      defineComponent({
        setup() {
          dock = usePermDock();
          return () => h('span', dock?.subject.principal?.id ?? '');
        },
      }),
    );
    app.use(permdockPlugin, { snapshot });
    const root = document.createElement('div');
    app.mount(root);
    expect(root.textContent).toBe('u1');
    snapshot.value = admin;
    await nextTick();
    await nextTick();
    expect(root.textContent).toBe('u2');
    app.unmount();
  });

  it('renders under <Suspense> once a snapshot promise settles', async () => {
    const promise = snapshotOf(memberUser);
    const Page = defineAsyncComponent(async () => {
      await promise;
      return guarded(
        () => permissions.post.update,
        () => ownPost,
      );
    });
    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(Suspense, null, {
              default: () => h(Page),
              fallback: () => h('u', 'loading'),
            });
        },
      }),
    );
    app.use(permdockPlugin, { snapshot: promise });
    const root = document.createElement('div');
    app.mount(root);
    expect(root.textContent).toBe('loading');
    await promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(root.textContent).toBe('granted');
    app.unmount();
  });
});
