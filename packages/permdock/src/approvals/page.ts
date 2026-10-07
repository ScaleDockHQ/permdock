import type {
  ApprovalListQuery,
  ApprovalPage,
  ApprovalRequest,
  ApprovalStore,
  ApprovalListFilter,
} from "./types.ts";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_PAGES = 1000;

/** The page size of a query: `limit` within 1 to 200, 50 when absent. */
export function approvalPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

/** Where a page starts: the `(createdAt, token)` of the last request before it. */
export type ApprovalCursorPosition = readonly [
  createdAt: string,
  token: string,
];

function positionOf(request: ApprovalRequest): ApprovalCursorPosition {
  return [request.createdAt, request.token];
}

function compare(a: ApprovalCursorPosition, b: ApprovalCursorPosition): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  if (a[1] === b[1]) {
    return 0;
  }
  return a[1] < b[1] ? -1 : 1;
}

/** The `next` cursor after `request`, for a store that pages in its own query. */
export function encodeApprovalCursor(request: ApprovalRequest): string {
  return JSON.stringify(positionOf(request));
}

/** The `(createdAt, token)` position a `next` cursor names, or `null` for one that does not parse. */
export function decodeApprovalCursor(
  cursor: string,
): ApprovalCursorPosition | null {
  try {
    const parsed: unknown = JSON.parse(cursor);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

/**
 * Pages already-filtered requests in `(createdAt, token)` order, as the
 * built-in stores do: `limit` within 1 to 200 (50 when absent), `cursor` from
 * the previous page's `next`, and no items for a cursor that does not parse.
 * A custom `ApprovalStore` that filters in memory returns it from `list`.
 */
export function pageApprovals(
  matching: readonly ApprovalRequest[],
  query: ApprovalListQuery,
): ApprovalPage {
  const after =
    query.cursor === undefined ? undefined : decodeApprovalCursor(query.cursor);
  if (after === null) {
    return { items: [] };
  }
  const sorted = matching
    .filter(
      (request) =>
        after === undefined || compare(positionOf(request), after) > 0,
    )
    .toSorted((a, b) => compare(positionOf(a), positionOf(b)));
  const size = approvalPageSize(query.limit);
  const items = sorted.slice(0, size);
  const last = items.at(-1);
  return sorted.length > size && last !== undefined
    ? { items, next: encodeApprovalCursor(last) }
    : { items };
}

/** Every matching request of `store`, following `next` until the last page (at most 1000 pages of 200). */
export function listAllApprovals(
  store: ApprovalStore,
  filter: ApprovalListFilter,
): Promise<ApprovalRequest[]> {
  const collect = async (
    cursor: string | undefined,
    pages: number,
    items: readonly ApprovalRequest[],
  ): Promise<ApprovalRequest[]> => {
    const page = await store.list(
      cursor === undefined
        ? { ...filter, limit: MAX_PAGE_SIZE }
        : { ...filter, limit: MAX_PAGE_SIZE, cursor },
    );
    const next = [...items, ...page.items];
    return page.next === undefined || pages + 1 >= MAX_PAGES
      ? next
      : collect(page.next, pages + 1, next);
  };
  return collect(undefined, 0, []);
}
