import { expect, test } from '@playwright/test';

test.describe('eve-agent example', { tag: '@smoke' }, () => {
  test('continues list_posts without a prompt', async ({ request }) => {
    const response = await request.get('/list_posts');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: 'not-applicable' });
  });

  test('parks delete_post as user-approval', async ({ request }) => {
    const response = await request.get('/delete_post');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: 'user-approval' });
  });
});
