import { describe, expect, it } from 'vitest';

import type { DecisionEvent } from './interfaces.ts';

import { memorySink } from './sink.ts';

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
});
