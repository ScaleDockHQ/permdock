import { describe, expect, it } from 'vitest';

import { decisionToken } from '../../src/core/token.ts';

describe('decisionToken', () => {
  it('prefixes pd1 and is stable for the same inputs', () => {
    const input = {
      key: 'post.update',
      resourceId: 'p1',
      principal: { id: 'u1', roles: ['member'] as const },
      actor: undefined,
      fingerprint: 'fp',
    };
    const token = decisionToken(input);
    expect(token.startsWith('pd1.')).toBe(true);
    expect(decisionToken(input)).toBe(token);
    expect(
      decisionToken({
        ...input,
        principal: { id: 'u1', roles: ['member'], binding: { kid: 'k' } },
      }),
    ).toBe(token);
  });
});
