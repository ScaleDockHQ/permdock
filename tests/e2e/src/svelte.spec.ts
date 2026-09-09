import { expect, test } from '@playwright/test';

test.describe('svelte example', { tag: '@smoke' }, () => {
  test('shows granted edit and denied locked', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('edit', { exact: true })).toBeVisible();
    await expect(page.getByText('locked', { exact: true })).toBeVisible();
  });
});
