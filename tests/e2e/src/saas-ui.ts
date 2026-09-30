import type { Browser, Page } from '@playwright/test';

import { expect, test } from '@playwright/test';
import { saasPrivateJwk } from 'permdock/testing/saas';

/**
 * The scenarios every SaaS UI fixture passes, against one DOM contract:
 *
 * - `/login`: a `Sign in as <user>` button per user, landing on `/acme`;
 * - `/:org`: `[data-switch=<org>]` links, a `Sign out` button, a
 *   `[data-testid=nav][data-plan]` with `[data-nav=<id>]` links for granted
 *   items and `[data-upsell=<id>]` for pro items on a free plan;
 * - a non-member sees `[data-testid=forbidden]` and no `[data-nav]`;
 * - `/:org/<section>`: `[data-testid=section-content]` or the forbidden state;
 * - `/:org/projects`: `[data-project=<id>]` rows with a `Delete` button the
 *   snapshot grants; a server denial renders `Denied: <reason>` in an `output`;
 * - a poll of `/api/version` revalidates when the org's plan or the user's
 *   roles changed after the snapshot was issued (`window.saasPausePoll`
 *   pauses it).
 *
 * Scenario 10 also asserts the fixture's client scripts never carry the
 * server-only signing key.
 */
export type SaasUiOptions = {
  readonly origin: string;
  /** Milliseconds a refresh may take after a change; default 10 s. */
  readonly refreshTimeout?: number;
};

type SaasWindow = Window & { saasPausePoll?: boolean };

function nav(page: Page, id: string) {
  return page.locator(`[data-nav="${id}"]:visible`);
}

function upsell(page: Page, id: string) {
  return page.locator(`[data-upsell="${id}"]:visible`);
}

export async function signIn(
  page: Page,
  origin: string,
  user: string,
): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.getByRole('button', { name: `Sign in as ${user}` }).click();
  await page.waitForURL(`${origin}/acme`);
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

async function pausePoll(page: Page, paused: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as SaasWindow).saasPausePoll = value;
  }, paused);
}

export function saasUiScenarios(options: SaasUiOptions): void {
  const { origin } = options;
  const refresh = { timeout: options.refreshTimeout ?? 10_000 };

  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ request }) => {
    const response = await request.post(`${origin}/api/test/reset`);
    expect(response.ok()).toBe(true);
  });

  test('1. a cold load renders the granted nav and row actions', async ({
    page,
  }) => {
    await signIn(page, origin, 'alice');
    await page.goto(`${origin}/acme/projects`);
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(nav(page, 'members')).toBeVisible();
    await expect(
      page
        .locator('[data-project="p2"]')
        .getByRole('button', { name: 'Delete' }),
    ).toBeVisible();
  });

  test('2. switching org shows that org’s role and plan', async ({ page }) => {
    await signIn(page, origin, 'alice');
    await expect(nav(page, 'members')).toBeVisible();
    await page.locator('[data-switch="globex"]:visible').click();
    await page.waitForURL(`${origin}/globex`);
    await expect(nav(page, 'integrations')).toBeVisible();
    await expect(nav(page, 'members')).toHaveCount(0);
    await expect(page.locator('[data-testid="nav"]:visible')).toHaveAttribute(
      'data-plan',
      'pro',
    );
  });

  test('3. a forbidden page renders the forbidden state', async ({ page }) => {
    await signIn(page, origin, 'bob');
    await expect(nav(page, 'projects')).toBeVisible();
    await expect(nav(page, 'settings')).toHaveCount(0);
    await page.goto(`${origin}/acme/settings`);
    await expect(page.getByTestId('forbidden')).toBeVisible();
    await expect(page.getByTestId('section-content')).toHaveCount(0);
  });

  test('4. a billing change unlocks pro items for every member without sign-out', async ({
    page,
    browser,
    request,
  }) => {
    await signIn(page, origin, 'alice');
    const carol = await signedIn(browser, origin, 'carol');
    for (const member of [page, carol]) {
      await expect(upsell(member, 'analytics')).toBeVisible();
    }
    const response = await request.post(`${origin}/api/test/billing`, {
      data: { org: 'acme', plan: 'pro' },
    });
    expect(response.ok()).toBe(true);
    for (const member of [page, carol]) {
      await expect(nav(member, 'analytics')).toBeVisible(refresh);
      await expect(upsell(member, 'analytics')).toHaveCount(0);
    }
  });

  test('5. a demoted member is denied by the server at once and the UI follows', async ({
    page,
    request,
  }) => {
    await signIn(page, origin, 'bob');
    await page.goto(`${origin}/acme/projects`);
    const rocket = page.locator('[data-project="p1"]');
    await expect(rocket.getByRole('button', { name: 'Delete' })).toBeVisible();
    await pausePoll(page, true);
    const demoted = await request.post(`${origin}/api/test/set-role`, {
      data: { org: 'acme', user: 'bob', role: 'viewer' },
    });
    expect(demoted.ok()).toBe(true);
    await rocket.getByRole('button', { name: 'Delete' }).click();
    await expect(rocket.locator('output')).toHaveText(/^Denied: /u);
    await pausePoll(page, false);
    await expect(rocket.getByRole('button', { name: 'Delete' })).toHaveCount(
      0,
      refresh,
    );
  });

  test('6. signing out clears the nav and the next user never sees it', async ({
    page,
  }) => {
    await signIn(page, origin, 'alice');
    await expect(nav(page, 'members')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(`${origin}/login`);
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
    await page.waitForURL(`${origin}/acme`);
    await expect(nav(page, 'projects')).toBeVisible();
    await expect(nav(page, 'members')).toHaveCount(0);
    const seen = await page
      .evaluate(
        () =>
          (window as unknown as { saasSeen?: { members: boolean } }).saasSeen,
      )
      .catch(() => null);
    expect(seen?.members ?? false).toBe(false);
  });

  test('7. parallel users each get their own nav', async ({ browser }) => {
    const [alice, bob] = await Promise.all([
      signedIn(browser, origin, 'alice'),
      signedIn(browser, origin, 'bob'),
    ]);
    const round = async (index: number): Promise<void> => {
      await Promise.all([
        alice.goto(`${origin}/acme?round=${String(index)}`),
        bob.goto(`${origin}/acme?round=${String(index)}`),
      ]);
      await expect(nav(alice, 'members')).toBeVisible();
      await expect(nav(bob, 'projects')).toBeVisible();
      await expect(nav(bob, 'members')).toHaveCount(0);
    };
    await round(1);
    await round(2);
    await round(3);
  });

  test('8. a user with no live membership sees no org data', async ({
    browser,
  }) => {
    const noOrgData = async (user: string): Promise<void> => {
      const page = await signedIn(browser, origin, user);
      await expect(page.getByTestId('forbidden')).toBeVisible();
      await expect(page.locator('[data-nav]')).toHaveCount(0);
      await page.goto(`${origin}/acme/projects`);
      await expect(page.getByTestId('forbidden')).toBeVisible();
      await expect(page.locator('[data-project]')).toHaveCount(0);
      await page.context().close();
    };
    await noOrgData('mallory');
    await noOrgData('frank');
  });

  test('9. an admin of two orgs gets each org’s plan', async ({ page }) => {
    await signIn(page, origin, 'erin');
    await expect(nav(page, 'members')).toBeVisible();
    await expect(upsell(page, 'analytics')).toBeVisible();
    await page.goto(`${origin}/globex/analytics`);
    await expect(page.getByTestId('section-content')).toBeVisible();
    await expect(nav(page, 'analytics')).toBeVisible();
  });

  test('10. client scripts never carry the server signing key', async ({
    page,
  }) => {
    const scripts: Promise<string>[] = [];
    page.on('response', (response) => {
      if (response.request().resourceType() === 'script') {
        scripts.push(response.text().catch(() => ''));
      }
    });
    await signIn(page, origin, 'alice');
    await page.goto(`${origin}/acme/projects`);
    await expect(nav(page, 'members')).toBeVisible();
    const bodies = await Promise.all(scripts);
    expect(bodies.length).toBeGreaterThan(0);
    const leaked = bodies.filter((body) => body.includes(saasPrivateJwk.d));
    expect(leaked.length).toBe(0);
  });
}
