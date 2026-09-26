import type { Browser, Page } from '@playwright/test';

import { instant } from '@next/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JWT = 'http://127.0.0.1:3490';
const DATABASE = 'http://127.0.0.1:3491';
const NO_PRIVATE_CACHE = 'http://127.0.0.1:3492';
const INSTANT = { timeout: 3000 };

type SaasWindow = Window & { saasPausePoll?: boolean };

async function pausePoll(page: Page, paused: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as SaasWindow).saasPausePoll = value;
  }, paused);
}

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/next-saas',
);

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  for (const origin of [JWT, DATABASE, NO_PRIVATE_CACHE]) {
    const response = await request.post(`${origin}/api/test/reset`);
    expect(response.ok()).toBe(true);
  }
});

async function signIn(page: Page, origin: string, user: string): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.getByRole('button', { name: `Sign in as ${user}` }).click();
  await page.waitForURL(`${origin}/acme`);
  await expect(page.getByTestId('nav')).toBeVisible();
}

async function signedIn(
  browser: Browser,
  origin: string,
  user: string,
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, origin, user);
  return page;
}

function nav(page: Page, id: string) {
  return page.locator(`[data-nav="${id}"]:visible`);
}

/** Entering an org from outside its layout: the gates must come from the prefetch. */
async function enterOrgInstantly(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`);
  await page.waitForLoadState('networkidle');
  await instant(page, async () => {
    await page.locator('[data-org-link="acme"]').click();
    await page.waitForURL(`${origin}/acme`);
    await expect(nav(page, 'members')).toBeVisible(INSTANT);
    await expect(nav(page, 'settings')).toBeVisible(INSTANT);
    await expect(page.getByTestId('nav-skeleton')).toHaveCount(0, INSTANT);
  });
}

test('1. a cold load streams permissions into the static shell', async ({
  page,
}) => {
  await signIn(page, JWT, 'alice');
  await instant(
    page,
    async () => {
      await page.goto(`${JWT}/acme/projects`);
      await expect(
        page.getByRole('heading', { name: 'Projects' }),
      ).toBeVisible();
      await expect(page.getByTestId('nav-skeleton')).toBeVisible();
      await expect(nav(page, 'members')).toHaveCount(0);
    },
    { baseURL: JWT },
  );
  await expect(nav(page, 'members')).toBeVisible();
  await expect(
    page.locator('[data-project="p2"]').getByRole('button', { name: 'Delete' }),
  ).toBeVisible();
});

test('2. navigation within an org is instant with gates resolved', async ({
  page,
}) => {
  await signIn(page, JWT, 'alice');
  await enterOrgInstantly(page, JWT);
  await page.waitForLoadState('networkidle');
  await instant(page, async () => {
    await nav(page, 'settings').click();
    await page.waitForURL(`${JWT}/acme/settings`);
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible(
      INSTANT,
    );
    await expect(page.getByTestId('section-content')).toBeVisible(INSTANT);
    await expect(page.getByTestId('gate-pending')).toHaveCount(0, INSTANT);
  });
});

test('3. a forbidden page redirects in the proxy and renders a forbidden state without it', async ({
  page,
  browser,
}) => {
  await signIn(page, JWT, 'bob');
  await expect(nav(page, 'settings')).toHaveCount(0);
  await page.locator('[data-quick="settings"]').click();
  await page.waitForURL(`${JWT}/acme?denied=settings`);
  await expect(page.getByRole('status')).toContainText('Settings');

  const bypass = await browser.newContext({
    extraHTTPHeaders: { 'x-e2e-skip-proxy': '1' },
  });
  const direct = await bypass.newPage();
  await signIn(direct, JWT, 'bob');
  const response = await direct.goto(`${JWT}/acme/settings`);
  expect(response?.status()).toBe(200);
  await expect(direct.getByTestId('forbidden')).toBeVisible();

  const database = await signedIn(browser, DATABASE, 'bob');
  await database.goto(`${DATABASE}/acme/settings`);
  await expect(database).toHaveURL(`${DATABASE}/acme/settings`);
  await expect(database.getByTestId('forbidden')).toBeVisible();
});

test('4. switching org is instant and shows that org’s roles', async ({
  page,
  browser,
}) => {
  await signIn(page, JWT, 'alice');
  await expect(nav(page, 'members')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await instant(page, async () => {
    await page.locator('[data-switch="globex"]').click();
    await page.waitForURL(`${JWT}/globex`);
    await expect(nav(page, 'integrations')).toBeVisible(INSTANT);
    await expect(nav(page, 'members')).toHaveCount(0, INSTANT);
    await expect(page.locator('[data-testid="nav"]:visible')).toHaveAttribute(
      'data-plan',
      'pro',
      INSTANT,
    );
  });

  const dave = await signedIn(browser, JWT, 'dave');
  await expect(nav(dave, 'projects')).toBeVisible();
  await expect(nav(dave, 'members')).toHaveCount(0);
  await dave.goto(`${JWT}/acme/projects`);
  await expect(
    dave.locator('[data-project="p2"]').getByRole('button', { name: 'Delete' }),
  ).toHaveCount(0);
});

test('5. a billing webhook unlocks pro items for every member without sign-out', async ({
  page,
  browser,
  request,
}) => {
  await signIn(page, JWT, 'alice');
  const carol = await signedIn(browser, JWT, 'carol');
  for (const member of [page, carol]) {
    await expect(member.locator('[data-upsell="analytics"]')).toBeVisible();
  }
  const response = await request.post(`${JWT}/api/test/billing`, {
    data: { org: 'acme', plan: 'pro' },
  });
  expect(response.ok()).toBe(true);
  for (const member of [page, carol]) {
    await expect(nav(member, 'analytics')).toBeVisible({ timeout: 10_000 });
    await expect(member.locator('[data-upsell="analytics"]')).toHaveCount(0);
  }
});

async function demoteBob(browser: Browser, origin: string): Promise<void> {
  const alice = await signedIn(browser, origin, 'alice');
  await alice.goto(`${origin}/acme/members`);
  const row = alice.locator('[data-member="bob"]');
  await row.getByRole('combobox').selectOption('viewer');
  await row.getByRole('button', { name: 'Save role' }).click();
  await expect(row.locator('output')).toHaveText('Saved');
}

test('6a. database mode: a demoted member is denied at once and the UI follows', async ({
  page,
  browser,
}) => {
  await signIn(page, DATABASE, 'bob');
  await page.goto(`${DATABASE}/acme/projects`);
  const rocket = page.locator('[data-project="p1"]');
  await expect(rocket.getByRole('button', { name: 'Delete' })).toBeVisible();
  await pausePoll(page, true);

  await demoteBob(browser, DATABASE);
  await rocket.getByRole('button', { name: 'Delete' }).click();
  await expect(rocket.locator('output')).toHaveText(/^Denied: /u);

  await pausePoll(page, false);
  await expect(rocket.getByRole('button', { name: 'Delete' })).toHaveCount(0, {
    timeout: 10_000,
  });
});

test('6b. JWT mode: a demoted member keeps the old role until the token is re-issued', async ({
  page,
  browser,
}) => {
  await signIn(page, JWT, 'bob');
  await page.goto(`${JWT}/acme/projects`);
  const magnet = page.locator('[data-project="p3"]');
  await expect(magnet.getByRole('button', { name: 'Delete' })).toBeVisible();

  await demoteBob(browser, JWT);
  await page.waitForTimeout(1500);
  await expect(magnet.getByRole('button', { name: 'Delete' })).toBeVisible();
  await magnet.getByRole('button', { name: 'Delete' }).click();
  await expect(magnet).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, JWT, 'bob');
  await page.goto(`${JWT}/acme/projects`);
  await expect(page.locator('[data-project="p1"]')).toBeVisible();
  await expect(
    page.locator('[data-project="p1"]').getByRole('button', { name: 'Delete' }),
  ).toHaveCount(0);
});

test('7. signing out clears the shell and the next user never sees the previous nav', async ({
  page,
}) => {
  await signIn(page, JWT, 'alice');
  await expect(nav(page, 'members')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${JWT}/login`);
  await page.evaluate(() => {
    const seen = { members: false };
    (window as unknown as { saasSeen: typeof seen }).saasSeen = seen;
    new MutationObserver(() => {
      if (document.querySelector('[data-nav="members"]') !== null) {
        seen.members = true;
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: 'Sign in as bob' }).click();
  await page.waitForURL(`${JWT}/acme`);
  await expect(nav(page, 'projects')).toBeVisible();
  await expect(nav(page, 'members')).toHaveCount(0);
  const seen = await page.evaluate(
    () => (window as unknown as { saasSeen: { members: boolean } }).saasSeen,
  );
  expect(seen.members).toBe(false);
});

test('8. without the private cache, entering an org is not instant', async ({
  page,
}) => {
  await signIn(page, NO_PRIVATE_CACHE, 'alice');
  const failure = await enterOrgInstantly(page, NO_PRIVATE_CACHE).then(
    () => null,
    String,
  );
  expect(failure).toContain('[data-nav="members"]');
  await expect(nav(page, 'members')).toBeVisible();
});

test('9. next build prints no instant-validation warnings', () => {
  const log = readFileSync(join(fixture, '.e2e/build.log'), 'utf8');
  expect(log).toContain('Compiled successfully');
  expect(log).not.toMatch(/docs\/messages\/(?:blocking-|instant-)/u);
  expect(log).not.toMatch(/⚠.*(?:instant|prefetch|blocking)/iu);
});

test('10. an admin of two orgs gets each org’s plan in the nav', async ({
  page,
}) => {
  await signIn(page, JWT, 'erin');
  await expect(nav(page, 'members')).toBeVisible();
  await expect(page.locator('[data-upsell="analytics"]:visible')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await instant(page, async () => {
    await page.locator('[data-switch="globex"]').click();
    await page.waitForURL(`${JWT}/globex`);
    await expect(nav(page, 'analytics')).toBeVisible(INSTANT);
    await expect(nav(page, 'members')).toBeVisible(INSTANT);
    await expect(page.locator('[data-upsell="analytics"]:visible')).toHaveCount(
      0,
      INSTANT,
    );
  });
  await page.waitForLoadState('networkidle');
  await instant(page, async () => {
    await nav(page, 'analytics').click();
    await page.waitForURL(`${JWT}/globex/analytics`);
    await expect(page.getByTestId('section-content')).toBeVisible(INSTANT);
  });
});

test('11. a user with no live membership sees no org data', async ({
  browser,
}) => {
  for (const [origin, user] of [
    [JWT, 'mallory'],
    [DATABASE, 'mallory'],
    [JWT, 'frank'],
    [DATABASE, 'frank'],
  ] as const) {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/login`);
    await page.getByRole('button', { name: `Sign in as ${user}` }).click();
    await page.waitForURL(`${origin}/acme`);
    await expect(page.getByTestId('forbidden')).toBeVisible();
    await expect(page.locator('[data-nav]')).toHaveCount(0);

    await page.goto(`${origin}/acme/projects`);
    await expect(page.getByTestId('forbidden')).toBeVisible();
    await expect(page.locator('[data-project]')).toHaveCount(0);
    await page.context().close();
  }
});
