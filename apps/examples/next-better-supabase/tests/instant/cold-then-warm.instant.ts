import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { signIn } from "./session.ts";
import { loadedAt, settlePrefetches } from "./warm.ts";

// RLS reads run as the caller, so they are `'use cache: private'` and live
// only in the client router, which keeps a visited page for back and forward
// navigation. Going back renders the same rows under the lock.
test("going back to the staff list reuses its read", async ({ page }) => {
  await signIn(page, "olivia");
  await page.goto("/en/acme/quotes");
  const staffLink = page
    .locator('[data-nav="staff"]')
    .filter({ visible: true });
  const quotesLink = page
    .locator('[data-nav="quotes"]')
    .filter({ visible: true });
  const staff = page.getByTestId("staff").filter({ visible: true });
  const quotes = page.getByTestId("quotes").filter({ visible: true });
  await expect(quotes).toBeVisible();
  await settlePrefetches(page);
  await staffLink.click();
  await expect(staff).toBeVisible();
  const read = await loadedAt(page, "Staff");

  await settlePrefetches(page);
  await quotesLink.click();
  await expect(quotes).toBeVisible();
  await settlePrefetches(page);

  await instant(page, async () => {
    await page.goBack();
    await expect(staff).toBeVisible();
    expect(await loadedAt(page, "Staff")).toBe(read);
  });
});
