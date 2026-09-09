import { expect, test } from '@playwright/test';

test.describe('supabase-rls example', { tag: '@smoke' }, () => {
  test('grants member update of their own post', async ({ request }) => {
    const response = await request.patch('/posts/p1');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('denies member publish', async ({ request }) => {
    const response = await request.post('/posts/p1/publish');
    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ ok: false });
  });
});
