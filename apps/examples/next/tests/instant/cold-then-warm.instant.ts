import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { signIn } from "./session.ts";
import { loadedAt, settlePrefetches } from "./warm.ts";

test.beforeEach(async ({ page }) => {
  await signIn(page, "olivia");
});

// The first visit waits for the delayed store; every later one reads the
// cache, so `data-loaded-at` repeats and nothing waits for the store again.
test("a revisited quote is served from the cache without a store read", async ({
  page,
}) => {
  await page.goto("/acme/quotes");
  const quotes = page.getByTestId("quotes").filter({ visible: true });
  await expect(quotes).toBeVisible();
  const listed = await loadedAt(page, "Quotes");

  await page.reload();
  await expect(quotes).toBeVisible();
  expect(await loadedAt(page, "Quotes")).toBe(listed);

  await settlePrefetches(page);
  await page.locator('[data-quote="q-101"]').filter({ visible: true }).click();
  await expect(
    page.getByTestId("quote").filter({ visible: true }),
  ).toBeVisible();
  const read = await loadedAt(page, "Quote");

  await page.locator('[data-nav="quotes"]').filter({ visible: true }).click();
  await expect(quotes).toBeVisible();
  await settlePrefetches(page);
  await instant(page, async () => {
    await page
      .locator('[data-quote="q-101"]')
      .filter({ visible: true })
      .click();
    await expect(
      page.locator('[data-action="approve"]').filter({ visible: true }),
    ).toBeVisible();
    expect(await loadedAt(page, "Quote")).toBe(read);
  });
});
