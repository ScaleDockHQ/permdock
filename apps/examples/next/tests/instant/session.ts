import type { Page } from "@playwright/test";

import { expect } from "@playwright/test";

/**
 * Signs in through the API request context, which shares the page's cookie
 * jar, so the page itself never navigates before `instant()` takes the lock.
 */
export async function signIn(
  page: Page,
  user: "olivia" | "max" | "carol",
): Promise<void> {
  const response = await page.request.post("/api/session", {
    form: { user },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}
