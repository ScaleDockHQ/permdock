import { expect, test } from '@playwright/test';

test.describe('expo example', { tag: '@smoke' }, () => {
  test('shows granted edit and denied locked', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await expect(page.getByText('edit')).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('locked')).toBeVisible();
  });
});
