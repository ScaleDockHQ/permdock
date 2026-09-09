import { expect, test } from '@playwright/test';

test.describe('webmcp example', { tag: '@smoke' }, () => {
  test('registers allowed tools and excludes publish', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('post_read', { exact: true })).toBeVisible();
    await expect(page.getByText('post_update', { exact: true })).toBeVisible();
    await expect(page.getByText('post_create', { exact: true })).toBeVisible();
    await expect(page.getByText('post_list', { exact: true })).toBeVisible();
    await expect(page.getByText('post_delete', { exact: true })).toBeVisible();
    await expect(page.getByText('post_publish', { exact: true })).toHaveCount(
      0,
    );
  });
});
