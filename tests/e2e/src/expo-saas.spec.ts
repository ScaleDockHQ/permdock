import type { Page } from '@playwright/test';

import { saasPrivateJwk } from '@permdock/testing/saas';
import { expect, test } from '@playwright/test';

const origin = 'http://127.0.0.1:3504';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${origin}/api/test/reset`)).ok()).toBe(true);
});

async function signIn(page: Page, user: string): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.getByRole('button', { name: `Sign in as ${user}` }).click();
  await expect(page.getByTestId('user')).toHaveText(user);
}

/** React Native Web's `AppState` follows `visibilitychange`. */
async function foreground(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const value of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', {
        value,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  });
}

function nav(page: Page, id: string) {
  return page.getByTestId(`nav-${id}`);
}

test('1. a signed snapshot from the +api route renders the nav and row actions', async ({
  page,
}) => {
  await signIn(page, 'alice');
  await expect(nav(page, 'members')).toBeVisible();
  await expect(page.getByTestId('upsell-analytics')).toBeVisible();
  await expect(
    page.getByTestId('project-p2').getByRole('button', { name: 'Delete' }),
  ).toBeVisible();
});

test('2. a tampered snapshot is rejected on first launch', async ({ page }) => {
  await page.route('**/api/snapshot**', async (route) => {
    const response = await route.fetch();
    const jws = (await response.json()) as string;
    const [header, payload, signature] = jws.split('.');
    const tail = signature ?? '';
    const flipped = `${tail.slice(0, -2)}${tail.endsWith('AA') ? 'BB' : 'AA'}`;
    await route.fulfill({ response, json: `${header}.${payload}.${flipped}` });
  });
  await signIn(page, 'alice');
  await expect(page.getByTestId('project-p2')).toBeVisible();
  await expect(nav(page, 'overview')).toHaveCount(0);
  await expect(page.getByTestId('project-p2').getByRole('button')).toHaveCount(
    0,
  );
});

test('3. a relaunch without network answers from AsyncStorage', async ({
  page,
}) => {
  await signIn(page, 'alice');
  await expect(nav(page, 'members')).toBeVisible();
  await page.route('**/api/snapshot**', (route) => route.abort());
  await page.reload();
  await expect(page.getByTestId('user')).toHaveText('alice');
  await expect(nav(page, 'members')).toBeVisible();
});

test('4. a plan change reaches the app when it returns to the foreground', async ({
  page,
  request,
}) => {
  await signIn(page, 'alice');
  await expect(page.getByTestId('upsell-analytics')).toBeVisible();
  const billed = await request.post(`${origin}/api/test/billing`, {
    data: { org: 'acme', plan: 'pro' },
  });
  expect(billed.ok()).toBe(true);
  await foreground(page);
  await expect(nav(page, 'analytics')).toBeVisible();
});

test('5. a demoted member is denied by the server and the UI follows on foreground', async ({
  page,
  request,
}) => {
  await signIn(page, 'bob');
  const row = page.getByTestId('project-p1');
  await expect(row.getByRole('button', { name: 'Delete' })).toBeVisible();
  const demoted = await request.post(`${origin}/api/test/set-role`, {
    data: { org: 'acme', user: 'bob', role: 'viewer' },
  });
  expect(demoted.ok()).toBe(true);
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('result-p1')).toHaveText(/^Denied: /u);
  await foreground(page);
  await expect(row.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

test('6. the next user never sees the previous user’s stored snapshot', async ({
  page,
}) => {
  await signIn(page, 'alice');
  await expect(nav(page, 'members')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${origin}/login`);
  await page.route('**/api/snapshot**', (route) => route.abort());
  await signIn(page, 'bob');
  await expect(page.getByTestId('project-p1')).toBeVisible();
  await expect(nav(page, 'members')).toHaveCount(0);
  await expect(nav(page, 'overview')).toHaveCount(0);
  await page.unroute('**/api/snapshot**');
  await foreground(page);
  await expect(nav(page, 'projects')).toBeVisible();
  await expect(nav(page, 'members')).toHaveCount(0);
});

test('7. client scripts never carry the server signing key', async ({
  page,
}) => {
  const scripts: Promise<string>[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') {
      scripts.push(response.text().catch(() => ''));
    }
  });
  await signIn(page, 'alice');
  await expect(nav(page, 'members')).toBeVisible();
  const bodies = await Promise.all(scripts);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.filter((body) => body.includes(saasPrivateJwk.d))).toHaveLength(
    0,
  );
});
