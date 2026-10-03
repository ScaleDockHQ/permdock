import { flushSync, mount, unmount } from 'svelte';
import { get, type Readable } from 'svelte/store';
import { describe, expect, it } from 'vitest';

import type { Decision } from '../../src/core/decision.ts';
import type { Snapshot } from '../../src/core/interfaces.ts';
import type {
  ApprovalHandle,
  ClientPermDock,
  PermissionSet,
  PermissionState,
} from '../../src/svelte/types.ts';

import { createPermDock } from '../../src/core/permdock.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions as defs,
  policy,
} from '../fixtures/quick-start.ts';
import BareHarness from './BareHarness.test.svelte';
import StoresHarness from './StoresHarness.test.svelte';

async function memberSnapshot(): Promise<Snapshot> {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = await createPermDock(policy as never, memberUser);
  // SAFETY: snapshot() returns a Snapshot; the erased generic above hides its type.
  return server.snapshot() as Snapshot;
}

type Stores = {
  readonly permdock: ClientPermDock;
  readonly permission: Readable<PermissionState>;
  readonly permissions: Readable<PermissionSet>;
  readonly filtered: Readable<readonly unknown[] & { partial: boolean }>;
  readonly tenant: Readable<{
    tenant: string | null;
    tenants: readonly string[];
    switchTo: (id: string) => Promise<void>;
  }>;
  readonly memberships: Readable<readonly unknown[]>;
  readonly roles: Readable<{ roles: readonly { key: string }[] }>;
  readonly tenantRoles: Readable<{ roles: readonly { key: string }[] }>;
  readonly teamRoles: Readable<{ roles: readonly { key: string }[] }>;
  readonly assignable: Readable<readonly { key: string }[]>;
  readonly assignablePermissions: Readable<readonly unknown[]>;
  readonly subject: Readable<{
    principal: { id: string } | null;
    simulated: boolean;
  }>;
  readonly approval: Readable<ApprovalHandle>;
};

// SAFETY: a partial approval-required decision; the store reads only outcome, grant and token.
const required: Decision = {
  outcome: 'approval-required',
  grant: { permission: 'post.delete', role: 'member', approval: 'human' },
  token: 'pd1.token',
} as unknown as Decision;

function harness(props: Omit<Parameters<typeof StoresHarness>[1], 'onReady'>): {
  readonly value: unknown;
  readonly stop: () => Promise<void>;
} {
  const target = document.createElement('div');
  let value: unknown;
  const app = mount(StoresHarness, {
    target,
    props: {
      ...props,
      onReady: (next: unknown) => {
        value = next;
      },
    },
  });
  flushSync();
  return { value, stop: () => unmount(app) };
}

describe('permdock/svelte context stores', () => {
  it('throw without setPermDock', async () => {
    const { value, stop } = harness({ decision: required });
    expect(value).toBeInstanceOf(Error);
    expect(String(value)).toMatch(/stores require setPermDock/);
    await stop();
  });

  it('answer every store from the provided snapshot', async () => {
    const posts: string[] = [];
    const { value, stop } = harness({
      decision: required,
      options: {
        snapshot: await memberSnapshot(),
        approvals: '/api/approvals',
        fetch: async (input: string | URL | Request) => {
          posts.push(String(input));
          return new Response(JSON.stringify({ status: 'pending' }));
        },
      },
    });
    // SAFETY: the harness hands over the stores it built under setPermDock.
    const stores = value as Stores;
    expect(stores.permdock.subject.principal?.id).toBe('u1');
    expect(get(stores.permission).allowed).toBe(true);
    const set = get(stores.permissions);
    expect(set.granted.map((leaf) => leaf.key)).toEqual(['post.update']);
    const byKey: unknown = Reflect.get(set, 'post.update');
    expect(byKey).toMatchObject({ allowed: true });
    expect(set.get(defs.post.publish)?.allowed).toBe(false);
    expect([...get(stores.filtered)]).toEqual([ownPost]);
    expect(get(stores.filtered).partial).toBe(false);
    expect(get(stores.tenant)).toMatchObject({ tenant: null, tenants: [] });
    await get(stores.tenant).switchTo('o1');
    expect(stores.permdock.status()).toBe('ready');
    expect(get(stores.memberships)).toEqual([]);
    expect(get(stores.roles).roles.map((role) => role.key)).toEqual(['member']);
    expect(get(stores.tenantRoles).roles.map((role) => role.key)).toEqual([
      'member',
    ]);
    expect(get(stores.teamRoles).roles.map((role) => role.key)).toEqual([
      'member',
    ]);
    expect(get(stores.assignable)).toEqual([]);
    expect(get(stores.assignablePermissions)).toEqual([]);
    expect(get(stores.subject)).toMatchObject({
      principal: { id: 'u1' },
      simulated: false,
    });
    const handle = get(stores.approval);
    expect({ state: handle.state, token: handle.token }).toEqual({
      state: 'required',
      token: 'pd1.token',
    });
    await handle.request('please');
    expect(posts).toEqual(['/api/approvals']);
    expect(get(stores.approval).state).toBe('pending');
    await stop();
  });

  it('report no token for a decision that needs no approval', async () => {
    const { value, stop } = harness({
      decision: { outcome: 'denied', denials: [], alternatives: [] },
      options: { snapshot: await memberSnapshot() },
    });
    // SAFETY: the harness hands over the stores it built under setPermDock.
    const handle = get((value as Stores).approval);
    expect({ state: handle.state, token: handle.token }).toEqual({
      state: 'not-needed',
      token: undefined,
    });
    await stop();
  });
});

describe('permdock/svelte <Protected> without snippets', () => {
  it('renders nothing for granted, denied and other-tenant checks', async () => {
    const snapshot = await memberSnapshot();
    for (const props of [
      { permission: defs.post.update, data: ownPost },
      { permission: defs.post.update, data: otherPost },
      { permission: defs.post.update, data: ownPost, tenant: 'nowhere' },
    ]) {
      const target = document.createElement('div');
      const app = mount(BareHarness, {
        target,
        props: { options: { snapshot }, ...props },
      });
      flushSync();
      expect(target.textContent).toBe('');
      await unmount(app);
    }
  });
});
