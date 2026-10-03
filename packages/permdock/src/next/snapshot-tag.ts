/**
 * The `cacheTag` for one subject's cached snapshots: `permdock:<sub>`, or `permdock:anon`
 * without a subject. Tag the private cache with it and pass it to `updateTag` or
 * `revalidateTag` on every write that changes the subject's snapshot.
 */
export function snapshotTag(sub?: string | null): string {
  return `permdock:${sub === undefined || sub === null || sub === "" ? "anon" : sub}`;
}
