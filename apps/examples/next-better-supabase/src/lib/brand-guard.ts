const BRANDS: ReadonlySet<string> = new Set(["acme", "globex"]);

/** A slug outside the product's brands never reaches the organization lookup. */
export function brandGuard(slug: string): string | null {
  return BRANDS.has(slug) ? slug : null;
}
