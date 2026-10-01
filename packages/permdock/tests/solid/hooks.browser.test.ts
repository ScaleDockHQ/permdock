import { createComponent, createRoot, createSignal, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';

import type { Decision } from '../../src/core/decision.ts';
import type { Snapshot } from '../../src/core/interfaces.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import {
  useApproval,
  useAssignablePermissions,
  useAssignableRoles,
  usePermDock,
  usePermissions,
  useRoles,
  useSubject,
  useTenant,
} from '../../src/solid/hooks.ts';
import { Protected } from '../../src/solid/protected.ts';
import { PermDockProvider } from '../../src/solid/provider.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import {
  alice,
  ownProject,
  permissions as saas,
  policy as saasPolicy,
} from '../fixtures/saas.ts';

async function memberSnapshot(): Promise<Snapshot> {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = await createPermDock(policy as never, memberUser);
  // SAFETY: snapshot() returns a Snapshot; the erased generic above hides its type.
  return server.snapshot() as Snapshot;
}

async function aliceSnapshot(): Promise<Snapshot> {
  const server = await createPermDock(saasPolicy, alice, { tenant: 'acme' });
  // SAFETY: snapshot() returns a Snapshot without a signer.
  return server.snapshot({ tenants: 'all' }) as Snapshot;
}

function mount(
  props: Omit<Parameters<typeof PermDockProvider>[0], 'children'>,
  children: () => JSX.Element | (() => string),
): { readonly root: HTMLElement; readonly dispose: () => void } {
  const root = document.createElement('div');
  const dispose = render(
    () =>
      createComponent(PermDockProvider, {
        ...props,
        get children() {
          // SAFETY: Solid renders a function child as a reactive text node.
          return children() as JSX.Element;
        },
      }),
    root,
  );
  return { root, dispose };
}

// SAFETY: a partial approval-required decision; the store reads only outcome, grant and token.
const required: Decision = {
  outcome: 'approval-required',
  grant: { permission: 'post.delete', role: 'member', approval: 'human' },
  token: 'pd1.token',
} as unknown as Decision;

describe('permdock/solid hooks', () => {
  it('throw outside a provider', () => {
    expect(() =>
      createRoot((dispose) => {
        try {
          usePermDock();
        } finally {
          dispose();
        }
      }),
    ).toThrow(/hooks require <PermDockProvider>/);
  });

  it('answer a permission set by key and through get', async () => {
    let set: ReturnType<ReturnType<typeof usePermissions>> | undefined;
    const view = mount({ snapshot: await memberSnapshot() }, () => {
      const read = usePermissions(
        () => [permissions.post.update, permissions.post.publish],
        () => ownPost,
      );
      return () => {
        set = read();
        return String(set.granted.length);
      };
    });
    expect(view.root.textContent).toBe('1');
    const byKey: unknown =
      set === undefined ? undefined : Reflect.get(set, 'post.update');
    expect(byKey).toMatchObject({ allowed: true });
    expect(set?.get(permissions.post.publish)?.allowed).toBe(false);
    expect(set?.get(permissions.post.read)).toBeUndefined();
    view.dispose();
  });

  it('read tenants, scoped and assignable roles and the subject', async () => {
    let switchTo: ((id: string) => Promise<void>) | undefined;
    const view = mount(
      { snapshot: await aliceSnapshot(), tenant: 'acme' },
      () => {
        const tenant = useTenant();
        const acme = useRoles(() => ({ tenant: 'acme' }));
        const team = useRoles(() => ({ team: 'no-such-team' }));
        const held = useRoles();
        const assignable = useAssignableRoles();
        const leaves = useAssignablePermissions();
        const subject = useSubject();
        const keys = (roles: readonly { readonly key: string }[]): string =>
          roles.map((role) => role.key).join(',');
        return () => {
          switchTo = tenant().switchTo;
          return [
            tenant().tenant,
            tenant().tenants.join(','),
            keys(acme().roles),
            keys(team().roles),
            keys(held().roles),
            keys(assignable()),
            leaves().length > 0,
            subject().principal?.id,
            subject().simulated,
          ].join(':');
        };
      },
    );
    expect(view.root.textContent).toBe(
      'acme:acme,globex:admin:admin:admin:admin,member,viewer:true:alice:false',
    );
    await switchTo?.('globex');
    expect(view.root.textContent?.startsWith('globex:')).toBe(true);
    view.dispose();
  });

  it('track an approval request', async () => {
    const posts: string[] = [];
    let handle: ReturnType<ReturnType<typeof useApproval>> | undefined;
    const [decision, setDecision] = createSignal<Decision>(required);
    const view = mount(
      {
        snapshot: await memberSnapshot(),
        approvals: '/api/approvals',
        fetch: async (input) => {
          posts.push(String(input));
          return new Response(JSON.stringify({ status: 'pending' }));
        },
      },
      () => {
        const approval = useApproval(decision);
        return () => {
          handle = approval();
          return `${handle.state}:${handle.token ?? 'none'}`;
        };
      },
    );
    expect(view.root.textContent).toBe('required:pd1.token');
    await handle?.request('please');
    expect(posts).toEqual(['/api/approvals']);
    expect(view.root.textContent).toBe('pending:pd1.token');
    setDecision({ outcome: 'denied', denials: [], alternatives: [] });
    expect(view.root.textContent).toBe('not-needed:none');
    view.dispose();
  });
});

describe('permdock/solid <Protected>', () => {
  it('passes the decision to children and fallback functions', async () => {
    const view = mount({ snapshot: await memberSnapshot() }, () => [
      createComponent(Protected, {
        permission: permissions.post.update,
        data: ownPost,
        children: (decision: Decision) => `yes-${decision.outcome}`,
      }),
      createComponent(Protected, {
        permission: permissions.post.update,
        data: otherPost,
        fallback: (decision: Decision) => `no-${decision.outcome}`,
        children: 'other',
      }),
      createComponent(Protected, {
        permission: permissions.post.update,
        data: otherPost,
        children: 'hidden',
      }),
    ]);
    expect(view.root.textContent).toBe('yes-grantedno-denied');
    view.dispose();
  });

  it('decides for another tenant with the tenant prop', async () => {
    const globexProject = { ...ownProject, id: 'g1', orgId: 'globex' };
    const view = mount(
      { snapshot: await aliceSnapshot(), tenant: 'globex' },
      () => [
        createComponent(Protected, {
          permission: saas.project.update,
          data: ownProject,
          tenant: 'acme',
          fallback: 'acme-locked',
          children: 'acme-edit',
        }),
        createComponent(Protected, {
          permission: saas.project.update,
          data: globexProject,
          tenant: 'globex',
          fallback: 'globex-locked',
          children: 'globex-edit',
        }),
      ],
    );
    expect(view.root.textContent).toBe('acme-editglobex-locked');
    view.dispose();
  });

  it('renders nothing while pending without a pending prop', async () => {
    const view = mount({ snapshot: memberSnapshot() }, () =>
      createComponent(Protected, {
        permission: permissions.post.update,
        data: ownPost,
        children: 'edit',
      }),
    );
    expect(view.root.textContent).toBe('');
    view.dispose();
  });
});
