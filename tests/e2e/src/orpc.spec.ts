import { expect, test } from '@playwright/test';

test.describe('orpc example', { tag: '@smoke' }, () => {
  test('grants member update of their own post', async ({ request }) => {
    const response = await request.post('/rpc/posts/update', {
      headers: { 'content-type': 'application/json' },
      data: { json: { id: 'p1' } },
    });
    expect(response.status()).toBe(200);
    const body: { json?: { ok?: boolean } } = await response.json();
    expect(body.json?.ok).toBe(true);
  });

  test('denies member publish', async ({ request }) => {
    const response = await request.post('/rpc/posts/publish', {
      headers: { 'content-type': 'application/json' },
      data: { json: { id: 'p1' } },
    });
    expect(response.status()).toBe(403);
    const body: {
      json?: { code?: string; data?: { permission?: string } };
    } = await response.json();
    expect(body.json?.code).toBe('FORBIDDEN');
    expect(body.json?.data?.permission).toBe('post.publish');
  });
});
