import type { Page } from '@playwright/test';

import { instant } from '@next/playwright';
import { expect, test } from '@playwright/test';

const INSTANT = { timeout: 3000 };

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/test/reset');
  expect(response.ok()).toBe(true);
});

async function signIn(page: Page, name: string, landing: string) {
  await page.goto('/');
  await page
    .getByRole('button', { name: new RegExp(`^Sign in as ${name}`, 'u') })
    .click();
  await page.waitForURL(landing);
}

// Next keeps a previously visited layout mounted but hidden after a switch.
function nav(page: Page, id: string) {
  return page.locator(`[data-nav="${id}"]:visible`);
}

test('1. organization pages and switches are instant with gates resolved', async ({
  page,
}) => {
  await signIn(page, 'Olivia', '**/acme');
  await expect(nav(page, 'settings')).toBeVisible();
  await page.waitForLoadState('networkidle');

  await instant(page, async () => {
    await nav(page, 'quotes').click();
    await page.waitForURL('**/acme/quotes');
    await expect(page.getByRole('heading', { name: 'Quotes' })).toBeVisible(
      INSTANT,
    );
    await expect(nav(page, 'members')).toBeVisible(INSTANT);
    await expect(page.locator('[data-quote="q-101"]:visible')).toBeVisible(
      INSTANT,
    );
  });

  await page.waitForLoadState('networkidle');
  await instant(page, async () => {
    await page.locator('[data-switch="globex"]').click();
    await page.waitForURL('**/globex');
    await expect(nav(page, 'members')).toBeVisible(INSTANT);
    await expect(nav(page, 'settings')).toHaveCount(0, INSTANT);
    await expect(page.getByTestId('nav-skeleton')).toHaveCount(0, INSTANT);
  });
});

test('2. a prefetch={true} quote link renders its gated actions without a fallback', async ({
  page,
}) => {
  await signIn(page, 'Olivia', '**/acme');
  await page.goto('/acme/quotes');
  await expect(page.locator('[data-quote="q-101"]')).toBeVisible();
  await page.waitForLoadState('networkidle');

  await instant(page, async () => {
    await page.locator('[data-quote="q-101"]').click();
    await page.waitForURL('**/acme/quotes/q-101');
    await expect(page.locator('[data-action="approve"]')).toBeVisible(INSTANT);
    await expect(page.locator('[data-action="delete"]')).toBeVisible(INSTANT);
    await expect(page.getByTestId('quote-skeleton')).toHaveCount(0, INSTANT);
  });
});

test('3. a demotion through a Server Action with updateTag removes the gated UI', async ({
  page,
}) => {
  await signIn(page, 'Olivia', '**/acme');
  await page.goto('/acme/members');
  await page.locator('[data-change-role="olivia"]').click();
  await expect(page.locator('[data-role="olivia"]')).toHaveText('member');

  await nav(page, 'quotes').click();
  await page.waitForURL('**/acme/quotes');
  await expect(nav(page, 'settings')).toHaveCount(0);
  await page.locator('[data-quote="q-101"]').click();
  await page.waitForURL('**/acme/quotes/q-101');
  await expect(page.getByTestId('quote')).toBeVisible();
  await expect(page.locator('[data-action="approve"]')).toHaveCount(0);
  await expect(page.locator('[data-action="delete"]')).toHaveCount(0);
});

test('4. a portal contact moves between their quotes instantly and never sees another customer', async ({
  page,
}) => {
  await signIn(page, 'Carol', '**/portal/acme');
  const quotes = page.getByTestId('quotes');
  await expect(quotes.locator('[data-quote="q-101"]')).toBeVisible();
  await expect(quotes.locator('[data-quote="q-102"]')).toBeVisible();
  await expect(quotes.locator('[data-quote="q-103"]')).toHaveCount(0);
  await expect(quotes.locator('[data-quote="q-201"]')).toHaveCount(0);
  await page.waitForLoadState('networkidle');

  await instant(page, async () => {
    await quotes.locator('[data-quote="q-101"]').click();
    await page.waitForURL('**/portal/acme/quotes/q-101');
    await expect(page.locator('[data-action="approve"]')).toBeVisible(INSTANT);
    await expect(page.locator('[data-action="delete"]')).toHaveCount(
      0,
      INSTANT,
    );
  });

  for (const path of ['/portal/acme/quotes/q-201', '/acme/quotes/q-201']) {
    await page.goto(path);
    await expect(page.getByText('could not be found')).toBeVisible();
    await expect(page.getByTestId('quote')).toHaveCount(0);
  }
});

test('5. requireAccess renders forbidden for a member and unauthorized when signed out', async ({
  page,
  browser,
}) => {
  await signIn(page, 'Max', '**/acme');
  await expect(nav(page, 'settings')).toHaveCount(0);
  await page.goto('/acme/settings');
  await expect(page.getByTestId('forbidden')).toBeVisible();
  await expect(page.getByTestId('settings')).toHaveCount(0);

  const anonymous = await (await browser.newContext()).newPage();
  await anonymous.goto('/acme/settings');
  await expect(anonymous.getByTestId('unauthorized')).toBeVisible();
  await expect(anonymous.getByTestId('settings')).toHaveCount(0);
});

test('6. gates keep answering from the snapshot while offline', async ({
  page,
  context,
}) => {
  await signIn(page, 'Olivia', '**/acme');
  await expect(nav(page, 'settings')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId('offline')).toBeVisible();
  await expect(nav(page, 'members')).toBeVisible();
  await expect(nav(page, 'settings')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId('offline')).toHaveCount(0);
});
