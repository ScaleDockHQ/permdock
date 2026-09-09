import { expect, test } from '@playwright/test';

test.describe('next example', { tag: '@smoke' }, () => {
  test('shows edit on the granted page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('edit', { exact: true })).toBeVisible();
  });

  test('shows locked on the denied route', async ({ page }) => {
    await page.goto('/denied');
    await expect(page.getByText('locked', { exact: true })).toBeVisible();
  });
});
