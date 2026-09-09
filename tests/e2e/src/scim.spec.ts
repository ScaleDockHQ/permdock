import { expect, test } from '@playwright/test';

test.describe('scim example', { tag: '@smoke' }, () => {
  test('grants health', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('denies unauthenticated SCIM list', async ({ request }) => {
    const response = await request.get('/scim/v2/Users');
    expect([401, 403]).toContain(response.status());
  });
});
