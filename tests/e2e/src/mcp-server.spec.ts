import { expect, test } from '@playwright/test';

import { tools } from '../../../apps/examples/mcp-server/src/server.ts';

const extra = {
  clientId: 'mcp-1',
  scopes: ['post:list', 'post:update', 'post:delete'],
};

test.describe('mcp-server example', { tag: '@smoke' }, () => {
  test('grants update_post for a member on their own post', async () => {
    const tool = tools.get('update_post');
    expect(tool).toBeDefined();
    if (tool === undefined) {
      return;
    }
    const result = await tool.handler({}, extra);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'updated' }],
    });
  });

  test('returns approval-required for delete_post', async () => {
    const tool = tools.get('delete_post');
    expect(tool).toBeDefined();
    if (tool === undefined) {
      return;
    }
    const result: unknown = await Promise.resolve(tool.handler({}, extra));
    expect(result).toEqual(
      expect.objectContaining({
        structuredContent: expect.objectContaining({
          outcome: 'approval-required',
        }),
      }),
    );
  });
});
