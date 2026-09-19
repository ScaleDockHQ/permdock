import { describe, expect, it } from 'vitest';

import type {
  DecisionEvent,
  DirectoryEvent,
  TokenSigner,
} from './interfaces.ts';

import { membershipEvent, memorySink, signDecisionBatch } from './sink.ts';

const event = (id: string): DecisionEvent => ({
  type: 'decision',
  at: '2026-01-01T00:00:00.000Z',
  outcome: 'granted',
  permission: 'post.read',
  scope: 'post:read',
  resource: { type: 'post', id },
  subject: { principal: { id: 'u1', roles: ['member'] } },
  trusted: true,
  source: 'decide',
});

describe('memorySink', () => {
  it('buffers events and drops the oldest past capacity', () => {
    const sink = memorySink({ capacity: 2 });
    sink.write([event('1'), event('2'), event('3')]);
    expect(sink.events().map((item) => item.resource.id)).toEqual(['2', '3']);
  });

  it('signs each write as a permdock-decisions+jwt batch', async () => {
    const signed: {
      readonly payload: Readonly<Record<string, unknown>>;
      readonly typ: string;
    }[] = [];
    const signer: TokenSigner = {
      async sign(payload, options) {
        signed.push({ payload, typ: options.typ });
        return 'jws.batch';
      },
    };
    const sink = memorySink({
      signer,
      audience: 'https://siem.example.com',
      source: 'https://app.example.com',
    });
    await sink.write([event('42')]);
    expect(sink.batches()).toEqual(['jws.batch']);
    expect(signed[0]?.typ).toBe('permdock-decisions+jwt');
    const events = signed[0]?.payload.events as readonly Record<
      string,
      unknown
    >[];
    expect(events[0]).toMatchObject({
      specversion: '1.0',
      type: 'dev.permdock.decision',
      source: 'https://app.example.com',
      subject: 'post.read',
      datacontenttype: 'application/json',
      data: { permission: 'post.read', resource: { id: '42' } },
    });
  });

  it('swallows signer failures so a write never throws', async () => {
    const sink = memorySink({
      signer: {
        sign() {
          return Promise.reject(new Error('unavailable'));
        },
      },
    });
    await expect(sink.write([event('1')])).resolves.toBeUndefined();
    expect(sink.batches()).toEqual([]);
    expect(sink.events()).toHaveLength(1);
  });
});

describe('signDecisionBatch', () => {
  it('envelopes directory and approval events', async () => {
    const directory: DirectoryEvent = {
      type: 'directory',
      at: '2026-01-01T00:00:00.000Z',
      source: 'scim',
      operation: 'patch',
      tenant: 'o_acme',
      resource: { type: 'User', id: 'u_1' },
      credential: { kind: 'token' },
      active: false,
    };
    const approval: DecisionEvent = {
      ...event('9'),
      phase: 'requested',
    };
    let captured: readonly unknown[] = [];
    await signDecisionBatch([directory, approval], {
      async sign(payload) {
        captured = payload.events as readonly unknown[];
        return 'jws';
      },
    });
    expect(captured).toMatchObject([
      { type: 'dev.permdock.directory', subject: 'u_1' },
      { type: 'dev.permdock.approval', subject: 'post.read' },
    ]);
  });

  it('envelopes membership events with principal id as subject', async () => {
    const membership = membershipEvent({
      source: 'app',
      operation: 'changed',
      principal: { id: 'u_2' },
      tenant: 'o_1',
      roles: { added: ['admin'], removed: ['member'] },
    });
    let captured: readonly unknown[] = [];
    await signDecisionBatch([membership], {
      async sign(payload) {
        captured = payload.events as readonly unknown[];
        return 'jws';
      },
    });
    expect(captured).toMatchObject([
      { type: 'dev.permdock.membership', subject: 'u_2' },
    ]);
  });
});
