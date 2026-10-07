import { instant } from "@next/playwright";
import { expect, test } from "@playwright/test";

import { origin } from "./origin.ts";
import { signIn } from "./session.ts";

test("/en/acme/staff serves its shell before the RLS rows", async ({
  page,
}) => {
  await signIn(page, "olivia");
  await instant(
    page,
    async () => {
      await page.goto("/en/acme/staff");
      await expect(page.locator('[data-switch="acme"]')).toBeVisible();
      await expect(page.getByTestId("page-title")).toHaveText("Staff");
      await expect(page.getByTestId("staff-skeleton")).toBeVisible();
      await expect(page.getByTestId("staff")).toHaveCount(0);
    },
    { baseURL: origin },
  );
});

test("/en/portal/acme/quotes serves its shell before the RLS rows", async ({
  page,
}) => {
  await signIn(page, "carla");
  await instant(
    page,
    async () => {
      await page.goto("/en/portal/acme/quotes");
      await expect(page.getByTestId("page-title")).toHaveText("Your quotes");
      await expect(page.getByTestId("quotes-skeleton")).toBeVisible();
      await expect(page.getByTestId("quotes")).toHaveCount(0);
    },
    { baseURL: origin },
  );
});
