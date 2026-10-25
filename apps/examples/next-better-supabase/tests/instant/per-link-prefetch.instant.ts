import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { signIn } from "./session.ts";
import { settlePrefetches } from "./warm.ts";

// The nav links use `prefetch={true}`, and `visibleStaff` is
// `'use cache: private'` with a `stale` of 30 s or more, so the per-link
// prefetch carries the RLS rows and they commit under the lock.
test("the Staff link's prefetch carries the RLS rows", async ({ page }) => {
  await signIn(page, "olivia");
  await page.goto("/en/acme/quotes");
  const trigger = page.locator('[data-nav="staff"]').filter({ visible: true });
  await expect(trigger).toBeVisible();
  await settlePrefetches(page);
  await instant(page, async () => {
    await trigger.click();
    await expect(
      page.getByTestId("page-title").filter({ visible: true }),
    ).toHaveText("Staff");
    await expect(
      page.getByTestId("staff").filter({ visible: true }),
    ).toBeVisible();
  });
});
