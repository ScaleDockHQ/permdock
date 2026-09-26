import type { Browser, Page } from '@playwright/test';

import { expect, test } from '@playwright/test';

const origin = 'http://127.0.0.1:3507';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${origin}/api/test/reset`)).ok()).toBe(true);
});

async function signIn(page: Page, user: string): Promise<void> {
  const response = await page.request.post(`${origin}/api/login`, {
    form: { user },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

async function openDoc(
  browser: Browser,
  user: string | null,
  doc: string,
  org = 'acme',
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  if (user !== null) {
    await signIn(page, user);
  }
  await page.goto(`${origin}/?org=${org}&doc=${doc}`);
  return page;
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator('#ws-status')).toHaveText('open');
  await expect(page.locator('#sse-status')).toHaveText('open');
}

async function edit(page: Page, text: string): Promise<void> {
  await page.getByLabel('Text').fill(text);
  await page.getByRole('button', { name: 'Send edit' }).click();
}

async function setRole(
  page: Page,
  user: string,
  org: string,
  role: string,
): Promise<void> {
  const response = await page.request.post(`${origin}/api/test/set-role`, {
    data: { org, user, role },
  });
  expect(response.ok()).toBe(true);
}

test('1. a team lead edit reaches every reader live, on the socket and the feed', async ({
  browser,
}) => {
  const gina = await openDoc(browser, 'gina', 'd1');
  const alice = await openDoc(browser, 'alice', 'd1');
  await ready(gina);
  await ready(alice);
  await expect(alice.locator('#content')).toHaveText('Roadmap');

  await edit(gina, 'Q3 plan');

  await expect(alice.locator('#content')).toHaveText('Q3 plan');
  await expect(gina.locator('#content')).toHaveText('Q3 plan');
  await expect(alice.locator('#activity li')).toHaveText(['gina edited d1']);
});

test('2. each message is checked: a reader cannot edit and keeps the socket', async ({
  browser,
}) => {
  const gina = await openDoc(browser, 'gina', 'd1');
  const alice = await openDoc(browser, 'alice', 'd1');
  await ready(gina);
  await ready(alice);

  await edit(alice, 'hijacked');

  await expect(alice.locator('#denied')).toHaveText(/^Denied: /u);
  await expect(alice.locator('#ws-status')).toHaveText('open');
  await expect(gina.locator('#content')).toHaveText('Roadmap');
  await expect(alice.locator('#activity li')).toHaveCount(0);
});

test('3. a locked doc and another team’s doc refuse the lead’s edits', async ({
  browser,
}) => {
  for (const doc of ['d2', 'd3']) {
    // oxlint-disable-next-line no-await-in-loop -- one doc at a time
    const gina = await openDoc(browser, 'gina', doc);
    // oxlint-disable-next-line no-await-in-loop -- one doc at a time
    await ready(gina);
    // oxlint-disable-next-line no-await-in-loop -- one doc at a time
    await edit(gina, 'overwritten');
    // oxlint-disable-next-line no-await-in-loop -- one doc at a time
    await expect(gina.locator('#denied')).toHaveText(/^Denied: /u);
    // oxlint-disable-next-line no-await-in-loop -- one doc at a time
    await expect(gina.locator('#content')).not.toHaveText('overwritten');
  }
});

test('4. a demoted user’s socket closes with 1008 and the feed ends; others stay', async ({
  browser,
}) => {
  const gina = await openDoc(browser, 'gina', 'd1');
  const alice = await openDoc(browser, 'alice', 'd1');
  await ready(gina);
  await ready(alice);

  await setRole(gina, 'gina', 'acme', 'guest');

  await expect(gina.locator('#ws-status')).toHaveText(
    /^closed 1008 .*\/denied$/u,
  );
  await expect(gina.locator('#sse-status')).toHaveText('revoked denied');
  await expect(alice.locator('#ws-status')).toHaveText('open');
  await expect(alice.locator('#sse-status')).toHaveText('open');

  await gina.reload();
  await expect(gina.locator('#ws-status')).toHaveText(/^closed 1006/u);
  await expect(gina.locator('#sse-status')).toHaveText('error');
});

test('5. a change for another user or another tenant leaves the connection open', async ({
  browser,
}) => {
  const gina = await openDoc(browser, 'gina', 'd1');
  const alice = await openDoc(browser, 'alice', 'd1');
  await ready(gina);
  await ready(alice);

  await setRole(alice, 'bob', 'acme', 'viewer');
  await setRole(alice, 'alice', 'globex', 'member');
  await edit(gina, 'still here');

  await expect(alice.locator('#content')).toHaveText('still here');
  await expect(alice.locator('#ws-status')).toHaveText('open');
  await expect(gina.locator('#ws-status')).toHaveText('open');
});

test('6. signing out in another tab ends every connection of that user', async ({
  browser,
}) => {
  const alice = await openDoc(browser, 'alice', 'd1');
  const gina = await openDoc(browser, 'gina', 'd1');
  await ready(alice);
  await ready(gina);

  const other = await alice.context().newPage();
  await other.request.post(`${origin}/api/logout`, { maxRedirects: 0 });

  await expect(alice.locator('#ws-status')).toHaveText(
    /^closed 1008 .*\/unauthenticated$/u,
  );
  await expect(alice.locator('#sse-status')).toHaveText(
    'revoked session-revoked',
  );
  await expect(gina.locator('#ws-status')).toHaveText('open');
});

test('7. the upgrade is refused for another tenant’s doc and for anonymous callers', async ({
  browser,
  request,
}) => {
  const crossTenant = await openDoc(browser, 'alice', 'd1', 'globex');
  await expect(crossTenant.locator('#ws-status')).toHaveText(/^closed 1006/u);
  await expect(crossTenant.locator('#sse-status')).toHaveText('error');
  const denied = await crossTenant.request.get(
    `${origin}/globex/docs/d1/events`,
  );
  expect(denied.status()).toBe(403);

  const anonymous = await openDoc(browser, null, 'd1');
  await expect(anonymous.locator('#ws-status')).toHaveText(/^closed 1006/u);
  const unauthenticated = await request.get(`${origin}/acme/docs/d1/events`);
  expect(unauthenticated.status()).toBe(401);
});
