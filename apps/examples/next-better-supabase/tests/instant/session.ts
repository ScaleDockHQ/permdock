import type { Page } from "@playwright/test";

import { expect } from "@playwright/test";

const users = {
  olivia: "00000000-0000-4000-8000-0000000000a1",
  carla: "00000000-0000-4000-8000-0000000000a3",
} as const;

/**
 * Mints the demo session through the API request context, which shares the
 * page's cookie jar, so the page itself never navigates before `instant()`
 * takes the lock.
 */
export async function signIn(
  page: Page,
  user: keyof typeof users,
): Promise<void> {
  const response = await page.request.get("/api/test/sign-in", {
    params: { user: users[user], next: "/en" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}
