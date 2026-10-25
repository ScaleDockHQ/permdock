import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { signIn } from "./session.ts";
import { settlePrefetches } from "./warm.ts";

// Olivia owns Acme and is a member of Globex, so Globex's nav lists Staff and
// not Quotes: the switch must carry Globex's snapshot, not keep Acme's.
test("switching to Globex commits Globex's gated nav", async ({ page }) => {
  await signIn(page, "olivia");
  await page.goto("/en/acme/staff");
  const trigger = page
    .locator('[data-switch="globex"]')
    .filter({ visible: true });
  await expect(
    page.locator('[data-nav="quotes"]').filter({ visible: true }),
  ).toBeVisible();
  await settlePrefetches(page);
  await instant(page, async () => {
    await trigger.click();
    await page.waitForURL("**/en/globex/staff");
    await expect(
      page.locator('[data-nav="staff"]').filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.locator('[data-nav="quotes"]').filter({ visible: true }),
    ).toHaveCount(0);
  });
});
