import type { Page } from "@playwright/test";

/**
 * Waits until no request has been in flight for 500 ms, so every prefetch the
 * page started has landed. With `DEMO_LATENCY_MS` a prefetch takes seconds,
 * and `instant()` only shows what a prefetch already carries.
 */
export async function settlePrefetches(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

/** The `data-loaded-at` of the visible `DataSource` named `name`. */
export async function loadedAt(page: Page, name: string): Promise<string> {
  const marker = page
    .locator(`[data-source="${name}"]`)
    .filter({ visible: true });
  const value = await marker.getAttribute("data-loaded-at");
  if (value === null) {
    throw new Error(`no data-loaded-at on the ${name} data source`);
  }
  return value;
}
