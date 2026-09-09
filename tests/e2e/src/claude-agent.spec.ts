import { expect, test } from '@playwright/test';

test.describe('claude-agent example', { tag: '@smoke' }, () => {
  test('allows list_posts for a member', async ({ request }) => {
    const response = await request.get('/list_posts');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      result: { behavior: 'allow', updatedInput: {} },
    });
  });

  test('defers delete_post to the PermissionRequest hook', async ({
    request,
  }) => {
    const response = await request.get('/delete_post');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ result: null });
  });
});
