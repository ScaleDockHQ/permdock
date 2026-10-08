import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { signIn } from "./session.ts";
import { settlePrefetches } from "./warm.ts";

test.beforeEach(async ({ page }) => {
  await signIn(page, "olivia");
});

// `<Link prefetch={true}>`: the prefetch carries the quote and its gated
// actions, because `quoteAccess` is `'use cache: private'` with a 300 s stale time.
test("a quote link arrives with the quote and its actions", async ({
  page,
}) => {
  await page.goto("/acme/quotes");
  const trigger = page
    .locator('[data-quote="q-101"]')
    .filter({ visible: true });
  await expect(trigger).toBeVisible();
  await settlePrefetches(page);
  await instant(page, async () => {
    await trigger.click();
    await expect(
      page.getByTestId("quote").filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.locator('[data-action="approve"]').filter({ visible: true }),
    ).toBeVisible();
  });
});

// The gated nav links use `prefetch`: the member list rides the prefetch.
test("the Members link arrives with the member list", async ({ page }) => {
  await page.goto("/acme");
  const trigger = page
    .locator('[data-nav="members"]')
    .filter({ visible: true });
  await expect(trigger).toBeVisible();
  await settlePrefetches(page);
  await instant(page, async () => {
    await trigger.click();
    await expect(
      page.getByTestId("page-title").filter({ visible: true }),
    ).toHaveText("Members");
    await expect(
      page.getByTestId("members").filter({ visible: true }),
    ).toBeVisible();
  });
});
