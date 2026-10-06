import type {
  ApprovalCancelMeta,
  ApprovalListFilter,
  ApprovalListQuery,
  ApprovalPage,
  ApprovalRequest,
  ApprovalStore,
  ApprovalVerdict,
} from "../approvals/types.ts";
import type { SupabaseRpcCaller } from "./postgrest.ts";

import { ApprovalError } from "../approvals/errors.ts";
import { decodeCursor, encodeCursor, pageSizeOf } from "../approvals/page.ts";
import { applyApprovalVerdict } from "../approvals/store.ts";
import { canonicalJson } from "../core/canonical-json.ts";
import { compact } from "../core/compact.ts";
import { callRpc } from "./postgrest.ts";
import { PERMDOCK_SCHEMA } from "./sources.ts";

export type SupabaseApprovalStoreOptions = {
  /** Schema of the generated store functions (`rls.schema`). Default `permdock`. */
  readonly schema?: string;
  /** How long a request stays open when the caller sets no `ttl`, in milliseconds. */
  readonly ttl?: number;
  /**
   * Runs once per stored request, after the call that stored it, with the
   * stored request: notify the approvers, or cancel the requests this one
   * replaces. A repeated ask that finds the request still open does not run
   * it again. A throw fails the open, so the caller does not run the action.
   */
  readonly onOpen?: (request: ApprovalRequest) => void | Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A stored body as the request it is; the store wrote it from an `ApprovalRequest`. */
function requestOf(value: unknown): ApprovalRequest | null {
  if (
    !isRecord(value) ||
    value["v"] !== 1 ||
    typeof value["token"] !== "string"
  ) {
    return null;
  }
  // SAFETY: the body was written by this store from an ApprovalRequest; v and token are checked above.
  return value as ApprovalRequest;
}

function filterOf(filter: ApprovalListFilter): Record<string, string> {
  return compact({
    status: filter.status,
    tenant: filter.tenant,
    principalId: filter.principalId,
    actorId: filter.actorId,
    session: filter.session,
  });
}

/**
 * An `ApprovalStore` over the table and functions `rls.approvals` generates,
 * called through supabase-js (`client.schema(schema).rpc(...)`) with a
 * client that may execute them, such as a `service_role` client. Each method
 * is one atomic statement in the database: a repeated ask keeps the open
 * request, two racing approvers both count towards a quorum, and two racing
 * resumes never both consume an approval.
 */
export function supabaseApprovalStore(
  client: SupabaseRpcCaller,
  options: SupabaseApprovalStoreOptions = {},
): ApprovalStore {
  const schema = options.schema ?? PERMDOCK_SCHEMA;
  const call = async (
    fn: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    const result = await callRpc(client, schema, fn, args);
    if (result.error !== null) {
      throw new Error(
        `PermDock: ${schema}.${fn} failed: ${result.error.message}`,
      );
    }
    return result.data;
  };
  const get = async (token: string): Promise<ApprovalRequest | null> =>
    requestOf(await call("permdock_approval_get", { p_token: token }));
  return {
    ...(options.ttl === undefined ? {} : { ttl: options.ttl }),
    async create(request) {
      await call("permdock_approval_open", { p_request: request });
      if (options.onOpen !== undefined) {
        const stored = await get(request.token);
        if (
          stored !== null &&
          canonicalJson(stored) === canonicalJson(request)
        ) {
          await options.onOpen(stored);
        }
      }
    },
    get,
    async resolve(token: string, verdict: ApprovalVerdict) {
      const current = await get(token);
      if (current === null) {
        throw new ApprovalError("approval-not-found", "approval was not found");
      }
      const next = applyApprovalVerdict(current, verdict);
      const written = requestOf(
        await call("permdock_approval_resolve", {
          p_token: token,
          p_next: next,
          p_seen: current.approvals?.length ?? 0,
        }),
      );
      if (written === null) {
        throw new ApprovalError(
          "approval-not-pending",
          "approval is not pending",
        );
      }
      return written;
    },
    async consume(token, now = new Date()) {
      return requestOf(
        await call("permdock_approval_consume", {
          p_token: token,
          p_now: now.toISOString(),
        }),
      );
    },
    async list(query: ApprovalListQuery): Promise<ApprovalPage> {
      const after =
        query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      if (after === null) {
        return { items: [] };
      }
      const size = pageSizeOf(query.limit);
      const data = await call("permdock_approval_list", {
        p_filter: filterOf(query),
        p_after_created: after?.[0] ?? null,
        p_after_token: after?.[1] ?? null,
        p_limit: size + 1,
      });
      const rows = Array.isArray(data)
        ? data.flatMap((row) => {
            const request = requestOf(row);
            return request === null ? [] : [request];
          })
        : [];
      const items = rows.slice(0, size);
      const last = items.at(-1);
      return rows.length > size && last !== undefined
        ? { items, next: encodeCursor(last) }
        : { items };
    },
    async expire(now = new Date()) {
      const count = await call("permdock_approval_expire", {
        p_now: now.toISOString(),
      });
      return typeof count === "number" ? count : 0;
    },
    async cancel(filter: ApprovalListFilter, meta: ApprovalCancelMeta) {
      const count = await call("permdock_approval_cancel", {
        p_filter: filterOf(filter),
        p_by: meta.by,
        p_note: meta.note ?? null,
        p_now: new Date().toISOString(),
      });
      return typeof count === "number" ? count : 0;
    },
  };
}
