import type {
  ApprovalListQuery,
  ApprovalPage,
  ApprovalRequest,
  ApprovalStore,
  ApprovalListFilter,
} from './types.ts';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_PAGES = 1000;

function pageSizeOf(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

type Position = readonly [createdAt: string, token: string];

function positionOf(request: ApprovalRequest): Position {
  return [request.createdAt, request.token];
}

function compare(a: Position, b: Position): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  if (a[1] === b[1]) {
    return 0;
  }
  return a[1] < b[1] ? -1 : 1;
}

function encodeCursor(request: ApprovalRequest): string {
  return JSON.stringify(positionOf(request));
}

function decodeCursor(cursor: string): Position | null {
  try {
    const parsed: unknown = JSON.parse(cursor);
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

/** Pages already-filtered requests in `(createdAt, token)` order. */
export function pageOf(
  matching: readonly ApprovalRequest[],
  query: ApprovalListQuery,
): ApprovalPage {
  const after =
    query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  if (after === null) {
    return { items: [] };
  }
  const sorted = matching
    .filter(
      (request) =>
        after === undefined || compare(positionOf(request), after) > 0,
    )
    .toSorted((a, b) => compare(positionOf(a), positionOf(b)));
  const size = pageSizeOf(query.limit);
  const items = sorted.slice(0, size);
  const last = items.at(-1);
  return sorted.length > size && last !== undefined
    ? { items, next: encodeCursor(last) }
    : { items };
}

/** Every matching request, following `next` until the last page. */
export function listAll(
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
