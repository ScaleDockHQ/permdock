import { expect, test } from '@playwright/test';

import { expectAccessible } from './axe.ts';

test.describe('marketing', { tag: '@smoke' }, () => {
  test('shows the hero', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: /Typed permissions for TypeScript/ }),
    ).toBeVisible();
  });

  test('decide explorer switches outcomes', async ({ page }) => {
    await page.goto('/');
    const explorer = page.getByTestId('decide-explorer');
    await explorer.getByRole('button', { name: 'member' }).click();
    await explorer.getByRole('button', { name: 'delete' }).click();
    await expect(explorer.getByText('denied', { exact: true })).toBeVisible();
    await explorer.getByRole('button', { name: 'admin' }).click();
    await explorer.getByRole('button', { name: 'publish' }).click();
    await expect(
      explorer.getByText('approval-required', { exact: true }),
    ).toBeVisible();
  });

  test('pricing and compare render', async ({ page }) => {
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { name: 'Pricing' })).toBeVisible();
    await page.goto('/compare');
    await expect(
      page.getByRole('heading', { name: /In-process TypeScript/ }),
    ).toBeVisible();
  });

  test('changelog redirects to the docs changelog', async ({ page }) => {
    await page.goto('/changelog');
    await expect(page).toHaveURL(/\/docs\/changelog$/u);
    await expect(
      page.getByRole('heading', { name: 'Changelog', level: 1 }),
    ).toBeVisible();
  });

  for (const path of ['/', '/pricing', '/compare', '/cloud']) {
    test(`${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await page.goto(path);
      await expectAccessible(page);
    });
  }
});
