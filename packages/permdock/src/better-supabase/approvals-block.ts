import type {
  ApprovalListQuery,
  ApprovalPage,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalStore,
} from "../approvals/types.ts";
import type {
  ApprovalPolicy,
  ApprovalPolicySource,
} from "../core/approval-policies.ts";
import type { Approver } from "../core/approvers.ts";
import type { ApprovalOption } from "../core/policy-types.ts";

import { parseApprovalRequest } from "../approvals/parse-request.ts";
import { decisionTenant } from "../core/approval-state.ts";
import { compact, isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { isoAt } from "../core/time.ts";

/** better-supabase's `AsyncResult`: awaiting it gives `{ ok, data, error }`. */
type BlockResult<T> = PromiseLike<
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: unknown }
>;

/** A `Temporal.Instant`, as far as the bridge reads it. */
export type BlockInstant = { readonly toJSON: () => string };

type BlockStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "expired";

/** The approvals block's request; instants are `Temporal.Instant`. */
export type BlockApprovalRecord<I extends BlockInstant> = {
  readonly id: string;
  readonly status: BlockStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly fingerprint?: string;
  readonly expiresAt?: I;
  readonly decidedAt?: I;
  readonly consumedAt?: I;
  readonly createdAt: I;
};

export type BlockApprovalApprovers = {
  readonly permission?: string;
  readonly role?: string;
  readonly team?: string;
  readonly users?: readonly string[];
  readonly manager?: boolean;
};

/** The approvals block's tenant policy (`options.tenantPolicies`). */
export type BlockApprovalTenantPolicy = {
  readonly organizationId: string;
  readonly subjectType: string;
  readonly action: string;
  readonly conditions?: unknown;
  readonly mode: "confirm" | "authorize";
  readonly steps: readonly {
    readonly approvers: BlockApprovalApprovers;
    readonly required: number;
  }[];
  readonly selfApproval: boolean;
  readonly expiresIn?: string;
  readonly enabled: boolean;
};

/**
 * The calls `blockApprovalStore` makes on `createApprovals(...)` from
 * `better-supabase/blocks/approvals`.
 */
export type BlockApprovalsClient<I extends BlockInstant> = {
  readonly request: (
    subject: { readonly type: string; readonly id: string },
    input: {
      readonly action: string;
      readonly reason?: string;
      readonly payload?: Readonly<Record<string, unknown>>;
      readonly fingerprint?: string;
    },
  ) => BlockResult<BlockApprovalRecord<I>>;
  readonly list: (options?: {
    readonly status?: BlockStatus | null;
    readonly pageSize?: number;
    readonly before?: I;
  }) => BlockResult<readonly BlockApprovalRecord<I>[]>;
  readonly consume: (
    id: string,
    fingerprint?: string,
  ) => BlockResult<BlockApprovalRecord<I>>;
};

/** The call `blockApprovalPolicySource` makes on the approvals block. */
export type BlockApprovalPoliciesClient = {
  readonly listPolicies: (options?: {
    readonly subjectType?: string;
    readonly pageSize?: number;
  }) => BlockResult<readonly BlockApprovalTenantPolicy[]>;
};

const PAGE = 100;
const MAX_SCANNED = 2000;

function statusOf(status: BlockStatus): ApprovalStatus {
  switch (status) {
    case "pending":
    case "approved":
    case "rejected":
    case "expired":
      return status;
    case "cancelled":
      return "rejected";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function instantOf(value: BlockInstant | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ms = Date.parse(value.toJSON());
  return Number.isNaN(ms) ? undefined : isoAt(ms);
}

/** The PermDock request a block record carries, with the block's state. */
function requestOf<I extends BlockInstant>(
  record: BlockApprovalRecord<I>,
): ApprovalRequest | null {
  const stored = parseApprovalRequest(record.payload["permdock"]);
  if (stored === null) {
    return null;
  }
  const status = statusOf(record.status);
  return freezeDeep(
    compact<ApprovalRequest>({
      ...stored,
      status,
      expiresAt: instantOf(record.expiresAt) ?? stored.expiresAt,
      resolvedAt:
        status === "pending" ? undefined : instantOf(record.decidedAt),
      consumedAt: instantOf(record.consumedAt),
      fingerprint: record.fingerprint ?? stored.fingerprint,
    }),
  );
}

async function unwrap<T>(result: BlockResult<T>, call: string): Promise<T> {
  const awaited = await result;
  if (!awaited.ok) {
    throw new Error(`PermDock: the approvals block's ${call} failed`, {
      cause: awaited.error,
    });
  }
  return awaited.data;
}

/** Every block record carrying a PermDock request, newest first, capped. */
async function scan<I extends BlockInstant>(
  approvals: BlockApprovalsClient<I>,
  found: (pair: {
    readonly record: BlockApprovalRecord<I>;
    readonly request: ApprovalRequest;
  }) => boolean,
): Promise<
  readonly {
    readonly record: BlockApprovalRecord<I>;
    readonly request: ApprovalRequest;
  }[]
> {
  const out: {
    readonly record: BlockApprovalRecord<I>;
    readonly request: ApprovalRequest;
  }[] = [];
  let before: I | undefined;
  for (let scanned = 0; scanned < MAX_SCANNED; scanned += PAGE) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts before the last record of the previous one
    const page = await unwrap(
      approvals.list({
        status: null,
        pageSize: PAGE,
        ...(before === undefined ? {} : { before }),
      }),
      "list",
    );
    for (const record of page) {
      const request = requestOf(record);
      if (request !== null) {
        const pair = { record, request };
        out.push(pair);
        if (found(pair)) {
          return out;
        }
      }
    }
    const last = page.at(-1);
    if (page.length < PAGE || last === undefined) {
      break;
    }
    before = last.createdAt;
  }
  return out;
}

function actionOf(permission: string): string {
  const dot = permission.lastIndexOf(".");
  return dot === -1 ? permission : permission.slice(dot + 1);
}

function matchesQuery(
  request: ApprovalRequest,
  query: ApprovalListQuery,
): boolean {
  return (
    (query.status === undefined || request.status === query.status) &&
    (query.principalId === undefined ||
      request.subject.principal?.id === query.principalId) &&
    (query.actorId === undefined ||
      request.subject.actor?.id === query.actorId) &&
    (query.tenant === undefined ||
      decisionTenant(request.subject, request.membership) === query.tenant) &&
    (query.session === undefined || request.subject.session === query.session)
  );
}

/**
 * An `ApprovalStore` over better-supabase's approvals block, so a PermDock
 * `approval-required` decision files a block request and is decided in the
 * block's own approve and reject flow. `create` files the request on the
 * resource under the permission's action, with the PermDock request in
 * `payload.permdock` and its `fingerprint`. `get`, `getById` and `list` read
 * the block's latest 2,000 requests in the block's tenant. `consume` calls the
 * block's `consume`, which refuses a second use and another fingerprint.
 * `resolve` throws: approvers decide through the block, never through
 * `approvalsHandler`. `expire` answers 0, since the block expires requests
 * itself.
 */
export function blockApprovalStore<I extends BlockInstant>(
  approvals: BlockApprovalsClient<I>,
): ApprovalStore {
  const byToken = async (
    token: string,
  ): Promise<
    | {
        readonly record: BlockApprovalRecord<I>;
        readonly request: ApprovalRequest;
      }
    | undefined
  > =>
    (await scan(approvals, ({ request }) => request.token === token)).find(
      ({ request }) => request.token === token,
    );
  return Object.freeze({
    name: "better-supabase-approvals",
    async create(request: ApprovalRequest): Promise<void> {
      await unwrap(
        approvals.request(
          {
            type: request.resource.type,
            id: request.resource.id ?? request.id,
          },
          compact({
            action: actionOf(request.permission),
            reason: request.detail,
            payload: { permdock: request },
            fingerprint: request.fingerprint,
          }),
        ),
        "request",
      );
    },
    async get(token: string): Promise<ApprovalRequest | null> {
      return (await byToken(token))?.request ?? null;
    },
    async getById(id: string): Promise<ApprovalRequest | null> {
      const pairs = await scan(approvals, ({ request }) => request.id === id);
      return pairs.find(({ request }) => request.id === id)?.request ?? null;
    },
    resolve(): never {
      throw new Error(
        "PermDock: blockApprovalStore requests are decided through the approvals block's approve and reject, not resolve",
      );
    },
    async list(query: ApprovalListQuery): Promise<ApprovalPage> {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const offset = query.cursor === undefined ? 0 : Number(query.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return { items: [] };
      }
      const all = (await scan(approvals, () => false))
        .map(({ request }) => request)
        .filter((request) => matchesQuery(request, query))
        .toReversed()
        .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const items = all.slice(offset, offset + limit);
      return offset + limit < all.length
        ? { items, next: String(offset + limit) }
        : { items };
    },
    expire(): number {
      return 0;
    },
    async consume(token: string): Promise<ApprovalRequest | null> {
      const found = await byToken(token);
      if (found === undefined) {
        return null;
      }
      const consumed = await approvals.consume(
        found.record.id,
        found.request.fingerprint,
      );
      return consumed.ok ? requestOf(consumed.data) : null;
    },
  });
}

const INTERVAL_UNITS: Readonly<Record<string, number>> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 604_800,
};

/** Seconds in a Postgres interval such as `3 days` or `1 day 2 hours`. */
function intervalSeconds(interval: string): number {
  const parts = interval.trim().toLowerCase().split(/\s+/u);
  let seconds = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const amount = Number(parts[index]);
    const unit = parts[index + 1]?.replace(/s$/u, "");
    const size = unit === undefined ? undefined : INTERVAL_UNITS[unit];
    if (!Number.isSafeInteger(amount) || amount < 0 || size === undefined) {
      throw new TypeError(
        `PermDock: the approval policy interval '${interval}' is not whole seconds, minutes, hours, days or weeks`,
      );
    }
    seconds += amount * size;
  }
  if (seconds === 0) {
    throw new TypeError(
      `PermDock: the approval policy interval '${interval}' is empty`,
    );
  }
  return seconds;
}

function stageApprovers(
  approvers: BlockApprovalApprovers,
  roleScope: string,
): Approver {
  const leaves: Approver[] = [
    ...(approvers.permission === undefined
      ? []
      : [{ kind: "permission" as const, permission: approvers.permission }]),
    ...(approvers.role === undefined
      ? []
      : [{ kind: "role" as const, role: approvers.role, scope: roleScope }]),
    ...(approvers.users ?? []).map((id) => ({ kind: "user" as const, id })),
    ...(approvers.manager === true ? [{ kind: "manager" as const }] : []),
  ];
  if (leaves.length === 0) {
    throw new TypeError(
      "PermDock: an approval policy step names no approver PermDock can check (team approvers are not supported)",
    );
  }
  return { kind: "any-of", of: leaves };
}

function policyOf(
  entry: BlockApprovalTenantPolicy,
  roleScope: string,
): ApprovalPolicy {
  const approval: ApprovalOption = compact({
    stages:
      entry.steps.length === 0
        ? undefined
        : entry.steps.map((step) => ({
            by: stageApprovers(step.approvers, roleScope),
            quorum: step.required,
          })),
    combine: entry.steps.length > 1 ? ("sequential" as const) : undefined,
    mode:
      entry.mode === "confirm" && entry.selfApproval
        ? ("confirm" as const)
        : undefined,
    ttl:
      entry.expiresIn === undefined
        ? undefined
        : intervalSeconds(entry.expiresIn),
  });
  return {
    permission: `${entry.subjectType}.${entry.action}`,
    tenant: entry.organizationId,
    approval,
  };
}

export type BlockApprovalPolicySourceOptions = {
  /** The scope a step's `role` is held in. Default `tenant`. */
  readonly roleScope?: string;
};

/**
 * An `ApprovalPolicySource` over the approvals block's tenant policies, so a
 * PermDock decision asks for approval wherever the block would. A policy keys
 * the permission `<subjectType>.<action>`; its steps become sequential stages
 * whose approvers are any of the step's permission, role, users and manager;
 * `confirm` with `selfApproval` lets the principal approve; `expiresIn` caps
 * the request's `ttl`. `conditions` are not read, so a conditional policy
 * applies to every call: stricter, never looser. A step with only a `team`
 * approver, an interval it cannot read or a failed read makes the source fail,
 * and every call an allow would grant denies.
 */
export function blockApprovalPolicySource(
  approvals: BlockApprovalPoliciesClient,
  options: BlockApprovalPolicySourceOptions = {},
): ApprovalPolicySource {
  const roleScope = options.roleScope ?? "tenant";
  return Object.freeze({
    name: "better-supabase-approvals",
    async approvalPoliciesFor(query: {
      readonly tenants: readonly string[];
    }): Promise<readonly ApprovalPolicy[]> {
      const entries = await unwrap(
        approvals.listPolicies({ pageSize: 200 }),
        "listPolicies",
      );
      if (!Array.isArray(entries)) {
        throw new TypeError("PermDock: listPolicies answered no list");
      }
      return entries
        .filter(
          (entry: unknown): entry is BlockApprovalTenantPolicy =>
            isRecord(entry) &&
            entry["enabled"] === true &&
            typeof entry["organizationId"] === "string" &&
            query.tenants.includes(entry["organizationId"]),
        )
        .map((entry) => policyOf(entry, roleScope));
    },
  });
}
