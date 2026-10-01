import { describe, expect, it } from 'vitest';

import { createPermDock as createCorePermDock } from '../../src/core/permdock.ts';
import { createEvaluationsHandler } from '../../src/server/index.ts';
import { memberUser, policy } from '../fixtures/quick-start.ts';

function batch(size: number): Request {
  return new Request('https://api.example/access/v1/evaluations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      evaluations: Array.from({ length: size }, () => ({
        action: { name: 'post.read' },
        resource: { type: 'post', id: 'p1' },
      })),
    }),
  });
}

describe('createEvaluationsHandler batch limit', () => {
  it('answers an oversized batch with 413 before resolving an instance', async () => {
    let resolved = 0;
    const handler = createEvaluationsHandler({
      policy,
      maxEvaluations: 2,
      resolve: async () => {
        resolved += 1;
        return createCorePermDock(policy, memberUser);
      },
    });
    const response = await handler.POST(batch(3));
    expect(response.status).toBe(413);
    expect(response.headers.get('content-type')).toBe(
      'application/problem+json',
    );
    expect(resolved).toBe(0);
    expect((await handler.POST(batch(2))).status).toBe(200);
    expect(resolved).toBe(1);
  });

  it('defaults to the AuthZEN limit of 256', async () => {
    const handler = createEvaluationsHandler({
      policy,
      resolve: async () => createCorePermDock(policy, memberUser),
    });
    expect((await handler.POST(batch(257))).status).toBe(413);
    expect((await handler.POST(batch(256))).status).toBe(200);
  });
});
