import { expect, test } from "@playwright/test";

import { saasUiScenarios, signIn } from "./saas-ui.ts";

const origin = "http://127.0.0.1:3501";

saasUiScenarios({ origin });

test("11. the server-rendered nav hydrates without a mismatch", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (/hydrat/iu.test(message.text())) {
      warnings.push(message.text());
    }
  });
  await signIn(page, origin, "alice");
  await page.goto(`${origin}/acme/projects`);
  await expect(page.locator('[data-nav="members"]')).toBeVisible();
  // Vue sets `__vue_app__` on the root element once hydration has mounted.
  await page.waitForFunction(() => {
    const root = document.querySelector("#__nuxt");
    return root !== null && Reflect.has(root, "__vue_app__");
  });
  expect(warnings).toEqual([]);
});
