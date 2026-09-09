import { expect, test } from '@playwright/test';

test.describe('drizzle example', { tag: '@smoke' }, () => {
  test('grants member list of posts', async ({ request }) => {
    const response = await request.get('/posts');
    expect(response.status()).toBe(200);
    const body: { ok?: boolean } = await response.json();
    expect(body.ok).toBe(true);
  });

  test('denies member publish', async ({ request }) => {
    const response = await request.post('/posts/p1/publish');
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ ok: false });
  });
});
