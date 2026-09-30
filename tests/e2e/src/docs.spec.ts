import { expect, test } from '@playwright/test';

import { expectAccessible } from './axe.ts';

test.describe('docs', { tag: '@smoke' }, () => {
  test('renders the index', async ({ page }) => {
    await page.goto('/docs');
    await expect(
      page.getByRole('heading', { name: 'PermDock', level: 1 }),
    ).toBeVisible();
  });

  test('renders the DecideOptions type table', async ({ page }) => {
    await page.goto('/docs/concepts/decisions');
    await expect(
      page.getByRole('heading', { name: 'Options', level: 2 }),
    ).toBeVisible();
    await expect(
      page.locator('code').getByText('boundary?', { exact: true }),
    ).toBeVisible();
  });

  test('serves a page as Markdown', async ({ request }) => {
    const response = await request.get('/docs/concepts/decisions.md');
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('text/markdown');
    expect(await response.text()).toContain('# Decisions');
  });

  test('renders the changelog', async ({ page }) => {
    await page.goto('/docs/changelog');
    await expect(
      page.getByRole('heading', { name: 'Changelog', level: 1 }),
    ).toBeVisible();
  });

  for (const path of [
    '/docs',
    '/docs/concepts/decisions',
    '/docs/changelog',
    '/docs/ask',
  ]) {
    test(`${path} has no WCAG 2.2 AA violations`, async ({ page }) => {
      await page.goto(path);
      await expectAccessible(page);
    });
  }
});
