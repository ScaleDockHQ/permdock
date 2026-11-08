import type { PermDock } from "./permdock.ts";
import type { ExpandedSnapshot } from "./snapshot-types.ts";

/**
 * The key of the non-enumerable member an instance built by `getPermDock`
 * carries: its expanded snapshot without the wire compaction or the type-level
 * table. A spread copy or a wrapper does not carry it, so `mayUse` reads
 * `snapshot()` there.
 */
const EXPANDED_VIEW: unique symbol = Symbol("permdock.expandedView");

export type ExpandedView = () => ExpandedSnapshot;

export function withExpandedView<T extends object>(
  permdock: T,
  view: ExpandedView,
): T {
  Object.defineProperty(permdock, EXPANDED_VIEW, { value: view });
  return permdock;
}

export function expandedViewOf(permdock: PermDock): ExpandedView | undefined {
  const view: unknown = Reflect.get(permdock, EXPANDED_VIEW);
  // SAFETY: only withExpandedView writes this key, with an ExpandedView.
  return typeof view === "function" ? (view as ExpandedView) : undefined;
}
