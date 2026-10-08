import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { signIn } from "./session.ts";
import { settlePrefetches } from "./warm.ts";

test("Staff to Quotes commits the Quotes shell", async ({ page }) => {
  await signIn(page, "olivia");
  await page.goto("/en/acme/staff");
  const trigger = page.locator('[data-nav="quotes"]').filter({ visible: true });
  await expect(trigger).toBeVisible();
  await settlePrefetches(page);
  await instant(page, async () => {
    await trigger.click();
    await expect(
      page.getByTestId("page-title").filter({ visible: true }),
    ).toHaveText("Quotes");
  });
  await expect(
    page.getByTestId("quotes").filter({ visible: true }),
  ).toBeVisible();
});
