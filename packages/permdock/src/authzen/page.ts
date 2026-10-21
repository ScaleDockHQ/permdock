import { isRecord } from "../core/compact.ts";

/** The largest page a search answers; a larger `page.limit` is capped to it. */
export const AUTHZEN_MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

/** Where a search page starts and how many results it holds. */
export type AuthzenPageRequest = {
  readonly offset: number;
  readonly size: number;
};

export type AuthzenPage<T> = {
  readonly results: readonly T[];
  readonly page: {
    /**
     * The offset of the next page as a decimal string, or `""` on the last
     * page.
     */
    readonly next_token: string;
    readonly count: number;
    readonly total: number;
  };
};

/**
 * The page a search body asks for. The token is `page.token`, else
 * `page.next_token`, read as a decimal offset; anything else starts at 0. The
 * size is `page.limit`, else `page.size`, capped at 200 and 50 by default.
 */
export function readAuthzenPage(body: unknown): AuthzenPageRequest {
  const page =
    isRecord(body) && isRecord(body["page"]) ? body["page"] : undefined;
  const raw =
    typeof page?.["token"] === "string"
      ? page["token"]
      : typeof page?.["next_token"] === "string"
        ? page["next_token"]
        : "0";
  const parsed = Math.trunc(Number(raw));
  const sizeRaw = page?.["limit"] ?? page?.["size"];
  const size =
    typeof sizeRaw === "number" && sizeRaw > 0
      ? Math.min(sizeRaw, AUTHZEN_MAX_PAGE)
      : DEFAULT_PAGE;
  return { offset: Number.isFinite(parsed) && parsed > 0 ? parsed : 0, size };
}

/** One page of `items` with the AuthZEN `page` object. */
export function authzenPage<T>(
  items: readonly T[],
  request: AuthzenPageRequest,
): AuthzenPage<T> {
  const { offset, size } = request;
  const slice = items.slice(offset, offset + size);
  const next = offset + slice.length;
  return {
    results: slice,
    page: {
      next_token: next < items.length ? String(next) : "",
      count: slice.length,
      total: items.length,
    },
  };
}

/** The answer to a search the PDP cannot run: no results and no next page. */
export function emptyAuthzenPage<T>(): AuthzenPage<T> {
  return authzenPage([], { offset: 0, size: 1 });
}
