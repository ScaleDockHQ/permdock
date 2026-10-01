import { describe, expect, it } from 'vitest';

import { createPermDock } from '../../src/claude-agent/index.ts';
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

describe('permdock/claude-agent instance', () => {
  it('exposes the per-context instance and treats non-object input as empty', async () => {
    const { permdock, canUseTool } = createPermDock(policy, {
      subject: () => memberUser,
      tools: {
        Read: {
          permission: permissions.post.read,
          data: (args: unknown) => (args === null ? null : ownPost),
        },
      },
    });
    const dock = await permdock({ toolName: 'Read' });
    const signal = new AbortController().signal;
    // SAFETY: a malformed tool input the SDK could still pass at runtime.
    const input = ['not', 'an', 'object'] as unknown as Record<string, unknown>;
    const result = await canUseTool('Read', input, { signal });
    expect({
      principal: dock.subject.principal?.id,
      behavior: result.behavior,
    }).toEqual({ principal: 'u1', behavior: 'allow' });
  });
});
