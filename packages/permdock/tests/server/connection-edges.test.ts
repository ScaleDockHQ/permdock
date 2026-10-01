import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RevocationFeed } from '../../src/core/revocations.ts';
import type { Subject } from '../../src/core/subject.ts';
import type { User } from '../fixtures/quick-start.ts';

import { PermDockRevokedError } from '../../src/core/errors.ts';
import { memoryRevocationFeed } from '../../src/core/revocations.ts';
import { createPermDock } from '../../src/server/index.ts';
import {
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

type State = {
  id: string;
  roles: string[];
  fail?: boolean;
  expiresAt?: number;
  memberships?: { tenant: string; roles: string[]; expiresAt?: number }[];
};

function kernelFor(
  state: State,
  revocations: RevocationFeed = memoryRevocationFeed(),
) {
  let reads = 0;
  const kernel = createPermDock(policy, {
    revocations,
    tenant: () => 'o1',
    // SAFETY: the kernel accepts a full Subject in place of a user; it carries expiresAt and memberships.
    subject: ((): Subject => {
      reads += 1;
      if (state.fail === true) {
        throw new Error('directory down');
      }
      return {
        principal: {
          id: state.id,
          orgId: 'o1',
          roles: [...state.roles],
          ...(state.memberships === undefined
            ? {}
            : { memberships: state.memberships }),
        },
        context: {},
        ...(state.expiresAt === undefined
          ? {}
          : { expiresAt: state.expiresAt }),
      };
    }) as unknown as () => User,
  });
  return { kernel, revocations, reads: () => reads };
}

const request = (): Request =>
  new Request('https://api.example/stream?tenant=o1');

function codeOf(signal: AbortSignal): string {
  expect(signal.reason).toBeInstanceOf(PermDockRevokedError);
  // SAFETY: toBeInstanceOf above checked the reason is a PermDockRevokedError.
  return (signal.reason as PermDockRevokedError).code;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('connection data', () => {
  it('checks the opening permission against a plain row', async () => {
    const { kernel } = kernelFor({ id: 'u1', roles: ['member'] });
    const granted = await kernel.connection(request(), {
      permission: permissions.post.update,
      data: ownPost,
    });
    expect(granted.signal.aborted).toBe(false);
    const denied = await kernel.connection(request(), {
      permission: permissions.post.update,
      data: otherPost,
    });
    expect(codeOf(denied.signal)).toBe('denied');
  });

  it('re-runs a loader and aborts when the row is gone', async () => {
    const { kernel, revocations } = kernelFor({ id: 'u1', roles: ['member'] });
    let row: typeof ownPost | null = ownPost;
    const conn = await kernel.connection(request(), {
      permission: permissions.post.update,
      data: async () => row,
    });
    expect(conn.signal.aborted).toBe(false);
    await revocations.revoke({ principal: 'u1', kind: 'changed' });
    await settle();
    expect(conn.signal.aborted).toBe(false);
    row = null;
    await revocations.revoke({ principal: 'u1', kind: 'changed' });
    await settle();
    expect(codeOf(conn.signal)).toBe('denied');
    await revocations.revoke({ principal: 'u1', kind: 'session-revoked' });
    expect(codeOf(conn.signal)).toBe('denied');
  });

  it('aborts at open when the loader finds nothing', async () => {
    const { kernel } = kernelFor({ id: 'u1', roles: ['member'] });
    const conn = await kernel.connection(request(), {
      permission: permissions.post.update,
      data: () => undefined,
    });
    expect(codeOf(conn.signal)).toBe('denied');
  });
});

describe('connection lifecycle', () => {
  it('aborts with denied when the subject cannot be resolved', async () => {
    const { kernel } = kernelFor({ id: 'u1', roles: ['member'], fail: true });
    const conn = await kernel.connection(request(), {
      permission: permissions.post.list,
    });
    expect(codeOf(conn.signal)).toBe('denied');
  });

  it('aborts with subject-changed when the rebuild throws', async () => {
    const state: State = { id: 'u1', roles: ['member'] };
    const { kernel, revocations } = kernelFor(state);
    const conn = await kernel.connection(request(), {
      permission: permissions.post.list,
    });
    state.fail = true;
    await revocations.revoke({ principal: 'u1', kind: 'changed' });
    await settle();
    expect(codeOf(conn.signal)).toBe('subject-changed');
  });

  it('skips a revalidation queued before close', async () => {
    const { kernel, revocations, reads } = kernelFor({
      id: 'u1',
      roles: ['member'],
    });
    const conn = await kernel.connection(request(), {
      permission: permissions.post.list,
    });
    void revocations.revoke({ principal: 'u1', kind: 'changed' });
    conn.close();
    await settle();
    expect({ reads: reads(), aborted: conn.signal.aborted }).toEqual({
      reads: 1,
      aborted: false,
    });
  });

  it('aborts at open for an already expired subject', async () => {
    const { kernel } = kernelFor({ id: 'u1', roles: ['member'], expiresAt: 1 });
    const conn = await kernel.connection(request(), {
      permission: permissions.post.list,
    });
    expect(codeOf(conn.signal)).toBe('expired');
  });

  it('reschedules an expiry beyond the longest timer', async () => {
    vi.useFakeTimers();
    const now = Date.now() / 1000;
    const { kernel } = kernelFor({
      id: 'u1',
      roles: ['member'],
      expiresAt: now + 3_000_000,
    });
    const conn = await kernel.connection(request(), {
      permission: permissions.post.list,
    });
    vi.advanceTimersByTime(2_147_483_647);
    expect(conn.signal.aborted).toBe(false);
    vi.advanceTimersByTime(3_000_000_000 - 2_147_483_647 + 1_000);
    expect(codeOf(conn.signal)).toBe('expired');
  });

  it('revalidates at the earliest of several membership expiries', async () => {
    vi.useFakeTimers();
    const now = Date.now() / 1000;
    const { kernel, reads } = kernelFor({
      id: 'u1',
      roles: ['member'],
      memberships: [
        { tenant: 'o1', roles: ['member'], expiresAt: now + 20 },
        { tenant: 'o2', roles: ['member'], expiresAt: now + 5 },
        { tenant: 'o3', roles: ['member'], expiresAt: now + 50 },
        { tenant: 'o4', roles: ['member'], expiresAt: now - 5 },
        { tenant: 'o5', roles: ['member'] },
      ],
    });
    const conn = await kernel.connection(request());
    await vi.advanceTimersByTimeAsync(5_500);
    expect(reads()).toBe(2);
    conn.close();
  });

  it('ignores a changed event for another tenant', async () => {
    const { kernel, revocations, reads } = kernelFor({
      id: 'u1',
      roles: ['member'],
    });
    const conn = await kernel.connection(request(), {
      permission: permissions.post.list,
    });
    await revocations.revoke({
      principal: 'u1',
      kind: 'changed',
      tenant: 'o9',
    });
    await settle();
    expect(reads()).toBe(1);
    await revocations.revoke({
      principal: 'u1',
      kind: 'changed',
      tenant: 'o1',
    });
    await settle();
    expect(reads()).toBe(2);
    conn.close();
  });

  it('skips validation for a trusted check', async () => {
    const { kernel } = kernelFor({ id: 'u1', roles: ['member'] });
    const conn = await kernel.connection(request());
    expect(
      conn.check(
        permissions.post.update,
        { ...ownPost, extra: 1 },
        { trusted: true },
      ).outcome,
    ).toBe('granted');
    expect(conn.check(permissions.post.update, { id: 1 }).outcome).toBe(
      'denied',
    );
    conn.close();
  });
});
