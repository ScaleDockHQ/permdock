import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { WhereResult } from "../core/permdock.ts";
import type { Policy } from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";
import type { AuthzenSubjectLister } from "./search.ts";

/** What `search/resource` asks `resources.<type>.list` for. */
export type AuthzenResourceQuery = {
  /** The `properties` the request's resource names. */
  readonly where?: unknown;
  /**
   * The condition under which the subject holds the action on a row, as
   * `permdock.where(permission)` compiles it, for `toWhere`. Present for an
   * action on a row. A lister that applies it returns fewer rows; the handler
   * decides every row it gets, so one that ignores it is still correct.
   */
  readonly access?: WhereResult;
  /** The page size asked for. */
  readonly limit: number;
  /** The request's `page.token`, as the client sent it; none on the first page. */
  readonly cursor?: string;
};

/** One page `list` made itself: the handler pages no further. */
export type AuthzenResourcePage = {
  readonly rows: readonly unknown[];
  /** The cursor of the next page, sent back as `next_token`; none on the last. */
  readonly next?: string | undefined;
};

export type AuthzenResourceAdapter = {
  readonly data?: (id: string) => unknown;
  /**
   * The rows of the type. An array is paged in memory after the handler decides
   * it. A `{ rows, next }` page is the page `query.cursor` and `query.limit`
   * asked for, answered without a total.
   */
  readonly list?: (
    query: AuthzenResourceQuery,
  ) =>
    | readonly unknown[]
    | AuthzenResourcePage
    | Promise<readonly unknown[] | AuthzenResourcePage>;
};

export type AuthzenSubjectRecord = {
  readonly id: string;
  readonly [key: string]: unknown;
};

export type AuthzenPermDockOptions<TUser = unknown> = InstanceOptions & {
  readonly subject: (request: Request) => TUser | Promise<TUser>;
  readonly anonymous?: boolean;
  /**
   * Allow-list over the authenticated PEP. Only a PEP it returns `true` for may
   * evaluate the body's `subject`, `actor` and `delegation`; every other caller
   * is evaluated as itself. Off by default.
   */
  readonly trustedPep?: (pep: unknown) => boolean;
  readonly resources?: Readonly<Record<string, AuthzenResourceAdapter>>;
  /** Enables `search/subject`; discovery advertises it only when set. */
  readonly subjects?: AuthzenSubjectLister;
  readonly store?: ApprovalStore;
  readonly maxEvaluations?: number;
};

export type AuthzenPermDock = {
  readonly permdockHandler: () => (request: Request) => Promise<Response>;
};

export type AuthzenFactory = <TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: AuthzenPermDockOptions<TUser>,
) => AuthzenPermDock;
