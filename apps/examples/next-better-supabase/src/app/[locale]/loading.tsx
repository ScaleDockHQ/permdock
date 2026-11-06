/**
 * The shell shown while a route's first segment resolves; prefetched routes
 * never show it.
 */
export default function Loading() {
  return <p aria-busy="true">Loading</p>;
}
