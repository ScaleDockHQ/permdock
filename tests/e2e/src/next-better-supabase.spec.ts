import type { Page } from "@playwright/test";

import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

const INSTANT = { timeout: 3000 };

const users = {
  olivia: "00000000-0000-4000-8000-0000000000a1",
  mason: "00000000-0000-4000-8000-0000000000a2",
  carla: "00000000-0000-4000-8000-0000000000a3",
} as const;

const staff = {
  oliviaAtAcme: "00000000-0000-4000-8000-0000000000e1",
  masonAtAcme: "00000000-0000-4000-8000-0000000000e2",
  oliviaAtGlobex: "00000000-0000-4000-8000-0000000000e3",
} as const;

const quotes = {
  initech: "00000000-0000-4000-8000-0000000000f1",
  umbrella: "00000000-0000-4000-8000-0000000000f2",
  hooli: "00000000-0000-4000-8000-0000000000f3",
} as const;

/** Sign-in runs the PermDock access-token hook in Postgres and sets a better-supabase session cookie. */
async function signIn(page: Page, user: string, landing: string) {
  await page.goto(
    `/api/test/sign-in?user=${user}&next=${encodeURIComponent(landing)}`,
  );
  await page.waitForURL(`**${landing}`);
}

/** Snapshot-only mode: the app has no decision endpoint, so nothing may call one. */
function endpointCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/permdock")) {
      calls.push(request.url());
    }
  });
  return calls;
}

// Next keeps a previously visited layout mounted but hidden after a switch.
function visible(page: Page, selector: string) {
  return page.locator(`${selector}:visible`);
}

test("1. the snapshot rides the prefetch: page and organization switches are instant with gates resolved", async ({
  page,
}) => {
  const calls = endpointCalls(page);
  await signIn(page, users.olivia, "/en/acme/staff");
  await expect(visible(page, '[data-nav="quotes"]')).toBeVisible();
  await page.waitForLoadState("networkidle");

  await instant(page, async () => {
    await visible(page, '[data-nav="quotes"]').click();
    await page.waitForURL("**/en/acme/quotes");
    await expect(visible(page, `[data-quote="${quotes.initech}"]`)).toBeVisible(
      INSTANT,
    );
    await expect(
      visible(page, `[data-quote="${quotes.umbrella}"]`),
    ).toBeVisible(INSTANT);
  });

  await page.waitForLoadState("networkidle");
  await instant(page, async () => {
    await page.locator('[data-switch="globex"]').click();
    await page.waitForURL("**/en/globex/staff");
    await expect(visible(page, '[data-nav="staff"]')).toBeVisible(INSTANT);
    await expect(visible(page, '[data-nav="quotes"]')).toHaveCount(0, INSTANT);
    await expect(page.getByTestId("nav-skeleton")).toHaveCount(0, INSTANT);
    await expect(
      visible(page, `[data-staff="${staff.oliviaAtGlobex}"]`),
    ).toBeVisible(INSTANT);
  });

  expect(calls).toEqual([]);
});

test("2. RLS returns only the active organization rows and the nav follows the role", async ({
  page,
}) => {
  const calls = endpointCalls(page);
  await signIn(page, users.mason, "/en/acme/staff");
  const list = page.getByTestId("staff");
  await expect(
    list.locator(`[data-staff="${staff.masonAtAcme}"]`),
  ).toBeVisible();
  await expect(
    list.locator(`[data-staff="${staff.oliviaAtAcme}"]`),
  ).toBeVisible();
  await expect(
    list.locator(`[data-staff="${staff.oliviaAtGlobex}"]`),
  ).toHaveCount(0);
  await expect(page.locator('[data-nav="staff"]')).toBeVisible();
  await expect(page.locator('[data-nav="quotes"]')).toHaveCount(0);

  await page.goto("/en/acme/quotes");
  await expect(
    page.getByText("Only owners can see every quote."),
  ).toBeVisible();
  await expect(page.getByTestId("quotes")).toHaveCount(0);
  expect(calls).toEqual([]);
});

test("3. a portal contact reads only their customer quotes", async ({
  page,
}) => {
  await signIn(page, users.carla, "/en/portal/acme/quotes");
  const list = page.getByTestId("quotes");
  await expect(list.locator(`[data-quote="${quotes.initech}"]`)).toBeVisible();
  await expect(list.locator(`[data-quote="${quotes.umbrella}"]`)).toHaveCount(
    0,
  );
  await expect(list.locator(`[data-quote="${quotes.hooli}"]`)).toHaveCount(0);
});

test("4. signed out, every gate is closed and no rows are read", async ({
  page,
}) => {
  await page.goto("/en/acme/staff");
  await expect(
    page.getByText("Only staff can see the staff list."),
  ).toBeVisible();
  await expect(page.locator("[data-nav]")).toHaveCount(0);
});
