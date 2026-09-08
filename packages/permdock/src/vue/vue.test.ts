import { describe, expect, it } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';

import { createPermDock } from '../core/permdock.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { approvalHeaders } from '../react/headers.ts';
import {
  useFilter,
  useMemberships,
  usePermDock,
  usePermission,
  usePermissions,
  useRoles,
  useSubject,
  useTenant,
} from './composables.ts';
import { permdockPlugin } from './plugin.ts';
import { Protected } from './protected.ts';

async function memberSnapshot() {
  const server = await createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error('expected JSON snapshot');
  }
  return snapshot;
}

const Probe = defineComponent({
  setup() {
    const { allowed } = usePermission(permissions.post.update, ownPost);
    const actions = usePermissions(
      [permissions.post.update, permissions.post.publish],
      ownPost,
    );
    const editable = useFilter(permissions.post.update, [ownPost, otherPost]);
    const tenant = useTenant();
    const memberships = useMemberships();
    const roles = useRoles();
    const subject = useSubject();
    const dock = usePermDock();
    return () =>
      `${allowed.value}:${actions.value.granted.length}:${editable.value.length}:${editable.value.partial}:${tenant.value.tenant ?? 'none'}:${memberships.value.length}:${roles.value.roles.join(',')}:${subject.value.simulated}:${dock.status()}`;
  },
});

describe('permdock/vue', () => {
  it('renders portable grants from the snapshot without flashing deny', async () => {
    const snapshot = await memberSnapshot();
    const app = createSSRApp({
      setup() {
        return () =>
          h('div', [
            h(
              Protected,
              { permission: permissions.post.update, data: ownPost },
              { default: () => 'edit', fallback: () => 'locked' },
            ),
            h(
              Protected,
              { permission: permissions.post.update, data: otherPost },
              { default: () => 'edit', fallback: () => 'locked' },
            ),
          ]);
      },
    });
    app.use(permdockPlugin, { snapshot });
    const html = await renderToString(app);
    expect(html).toContain('edit');
    expect(html).toContain('locked');
  });

  it('exposes snapshot introspection through composables', async () => {
    const snapshot = await memberSnapshot();
    const app = createSSRApp({
      setup() {
        return () => h('span', [h(Probe)]);
      },
    });
    app.use(permdockPlugin, { snapshot });
    const html = await renderToString(app);
    expect(html).toContain('true:1:1:false');
    expect(html).toContain('member');
    expect(html).toContain('false:ready');
  });

  it('builds the approval resume header', () => {
    expect(approvalHeaders('pd1.abc')).toEqual({
      'PermDock-Approval': 'pd1.abc',
    });
  });
});
