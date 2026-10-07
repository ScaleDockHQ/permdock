import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { origin } from "./origin.ts";
import { signIn } from "./session.ts";

test("/acme serves its shell before the gated nav", async ({ page }) => {
  await signIn(page, "olivia");
  await instant(
    page,
    async () => {
      await page.goto("/acme");
      await expect(page.locator('[data-switch="acme"]')).toBeVisible();
      await expect(page.getByTestId("page-title")).toHaveText("Overview");
      await expect(page.getByTestId("nav-skeleton")).toBeVisible();
      await expect(page.getByTestId("nav")).toHaveCount(0);
    },
    { baseURL: origin },
  );
});

test("/portal/acme serves its shell before the quotes", async ({ page }) => {
  await signIn(page, "carol");
  await instant(
    page,
    async () => {
      await page.goto("/portal/acme");
      await expect(page.getByTestId("page-title")).toHaveText("Your quotes");
      await expect(page.getByTestId("quotes-skeleton")).toBeVisible();
      await expect(page.getByTestId("quotes")).toHaveCount(0);
    },
    { baseURL: origin },
  );
});
