import { describe, expect, it, vi } from 'vitest';

import type { ApprovalRequest } from '../../src/approvals/types.ts';
import type { SinkEvent, TokenVerifier } from '../../src/core/interfaces.ts';
import type { Subject } from '../../src/core/subject.ts';

import { isApprovalError } from '../../src/approvals/errors.ts';
import { cloud } from '../../src/cloud/create.ts';
import { fakeFetch, json } from '../fakes/fetch.ts';

const CLOUD_URL = 'https://cloud.permdock.test';

function client(
  reply: Parameters<typeof fakeFetch>[0],
  extra: Parameters<typeof cloud>[0] = {},
) {
  const fake = fakeFetch(reply);
  return {
    ...fake,
    client: cloud({ url: CLOUD_URL, key: 'k', fetch: fake.fetch, ...extra }),
  };
}

const by: Subject = { principal: { id: 'u2', roles: ['admin'] }, context: {} };

const event: SinkEvent = {
  type: 'membership',
  at: '2026-09-28T10:00:00.000Z',
  source: 'cloud',
  operation: 'changed',
  principal: { id: 'u_1' },
  roles: { added: ['admin'], removed: [] },
};

describe('cloud approvals over a failing API', () => {
  it('throws on a rejected create', async () => {
    const { client: c } = client(() => new Response(null, { status: 500 }));
    // SAFETY: create only serializes the record; its shape is irrelevant to a rejected call.
    await expect(
      c.approvals.create({ v: 1, token: 't' } as ApprovalRequest),
    ).rejects.toThrow('rejected the approval create');
  });

  it.each<[number, string]>([
    [409, 'approval-not-pending'],
    [410, 'approval-expired'],
    [404, 'approval-not-found'],
    [500, 'approval-not-found'],
  ])('maps a %d resolve to %s', async (status, code) => {
    const { client: c } = client(() => json({}, status));
    const error: unknown = await Promise.resolve()
      .then(() => c.approvals.resolve('t', { status: 'approved', by }))
      .catch((caught: unknown) => caught);
    expect(isApprovalError(error) ? error.code : undefined).toBe(code);
  });

  it('refuses an unknown approval shape from resolve', async () => {
    const { client: c } = client(() => json({ v: 2 }));
    await expect(
      Promise.resolve(c.approvals.resolve('t', { status: 'approved', by })),
    ).rejects.toThrow('unknown approval shape');
  });

  it('answers null, empty pages and zero on failures and bad shapes', async () => {
    const { client: failing } = client(
      () => new Response(null, { status: 500 }),
    );
    expect({
      get: await failing.approvals.get('t'),
      consume: await failing.approvals.consume('t', new Date(0)),
      list: await failing.approvals.list({}),
      expire: await failing.approvals.expire(new Date(0)),
    }).toEqual({ get: null, consume: null, list: { items: [] }, expire: 0 });

    const { client: shaped } = client(() => json({ items: 'x', expired: 'x' }));
    expect({
      list: await shaped.approvals.list({ limit: 5 }),
      expire: await shaped.approvals.expire(),
    }).toEqual({ list: { items: [] }, expire: 0 });

    const { client: offline } = client(() => {
      throw new Error('offline');
    });
    expect({
      get: await offline.approvals.get('t'),
      consume: await offline.approvals.consume('t'),
      list: await offline.approvals.list({}),
      expire: await offline.approvals.expire(),
    }).toEqual({ get: null, consume: null, list: { items: [] }, expire: 0 });
  });

  it('drops malformed list items and keeps a non-empty cursor only', async () => {
    const good = { v: 1, token: 't1' };
    const { client: c, calls } = client(() =>
      json({ items: [good, { v: 1 }, null], next: '' }),
    );
    expect(await c.approvals.list({ status: 'pending', tenant: 'o1' })).toEqual(
      { items: [good] },
    );
    expect(calls[0]?.url).toBe(
      `${CLOUD_URL}/v1/environments/production/approvals?status=pending&tenant=o1`,
    );
  });

  it('throws on a rejected or unknown cancel', async () => {
    const { client: rejected } = client(
      () => new Response(null, { status: 500 }),
    );
    await expect(
      Promise.resolve(rejected.approvals.cancel?.({}, { by: 'a' })),
    ).rejects.toThrow('rejected the approval cancel');
    const { client: odd } = client(() => json({ cancelled: 'all' }));
    await expect(
      Promise.resolve(odd.approvals.cancel?.({}, { by: 'a' })),
    ).rejects.toThrow('unknown cancel shape');
  });
});

describe('cloud sink and snapshots over a failing API', () => {
  it('re-queues a rejected batch and does nothing on an empty flush', async () => {
    let status = 500;
    const { client: c, calls } = client(() => new Response(null, { status }));
    await c.sink.flush?.();
    expect(calls.length).toBe(0);
    await c.sink.write([event]);
    await c.sink.flush?.();
    status = 204;
    await c.sink.flush?.();
    expect(calls.map((call) => JSON.parse(call.body))).toEqual([
      { events: [event] },
      { events: [event] },
    ]);
  });

  it('does not schedule a flush through waitUntil when the batch flushed inline', async () => {
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const { client: c } = client(() => new Response(null, { status: 204 }), {
      flushAt: 1,
      waitUntil,
    });
    await c.sink.write([event]);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('throws when the snapshot request fails', async () => {
    const { client: c } = client(() => new Response(null, { status: 503 }));
    await expect(c.snapshots.get()).rejects.toThrow('snapshot request failed');
  });
});

describe('cloud policies refresh', () => {
  const verifier: TokenVerifier = {
    verify: vi.fn<TokenVerifier['verify']>(async () => ({
      ok: true,
      header: { alg: 'Ed25519' },
      claims: { policy: { not: 'a policy' } },
    })),
  };

  it('keeps no document on network failure, 404, an error status, an unsigned body or a bad document', async () => {
    let reply: () => Response = () => {
      throw new Error('offline');
    };
    const { client: c } = client(() => reply(), { verifier });
    await c.policies.refresh();
    reply = () => new Response(null, { status: 404 });
    await c.policies.refresh();
    reply = () => new Response(null, { status: 500 });
    await c.policies.refresh();
    reply = () => new Response('{"a":1}');
    await c.policies.refresh();
    reply = () => new Response('a.b.c');
    await c.policies.refresh();
    expect(c.policies.current()).toBe(null);
  });
});
