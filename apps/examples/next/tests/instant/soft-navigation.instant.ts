import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { signIn } from "./session.ts";

const title = '[data-testid="page-title"]';

test.beforeEach(async ({ page }) => {
  await signIn(page, "olivia");
});

test("Overview to Quotes commits the Quotes shell", async ({ page }) => {
  await page.goto("/acme");
  const trigger = page.locator('[data-nav="quotes"]').filter({ visible: true });
  await expect(trigger).toBeVisible();
  await instant(page, async () => {
    await trigger.click();
    await expect(page.locator(title).filter({ visible: true })).toHaveText(
      "Quotes",
    );
  });
  await expect(
    page.getByTestId("quotes").filter({ visible: true }),
  ).toBeVisible();
});

test("switching organization commits the Globex shell", async ({ page }) => {
  await page.goto("/acme");
  const trigger = page
    .locator('[data-switch="globex"]')
    .filter({ visible: true });
  await expect(trigger).toBeVisible();
  await instant(page, async () => {
    await trigger.click();
    await expect(page).toHaveURL(/\/globex$/u);
    await expect(page.locator(title).filter({ visible: true })).toHaveText(
      "Overview",
    );
  });
});
