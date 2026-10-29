import type {
  ApprovalListQuery,
  ApprovalPage,
  ApprovalRequest,
  ApprovalStatus,
  ApprovalStore,
  ApprovalVerdict,
} from "../approvals/types.ts";
import type { Condition } from "../conditions/ast.ts";
import type {
  ApprovalPolicy,
  ApprovalPolicySource,
} from "../core/approval-policies.ts";
import type { Approver } from "../core/approvers.ts";
import type { OperationEffect } from "../core/operations.ts";
import type { PermissionTree } from "../core/permission-types.ts";
import type { ApprovalOption } from "../core/policy-types.ts";

import { ApprovalError } from "../approvals/errors.ts";
import { parseApprovalRequest } from "../approvals/parse-request.ts";
import { applyApprovalVerdict } from "../approvals/store.ts";
import { decisionTenant } from "../core/approval-state.ts";
import { compact, isRecord } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { isOperationEffect } from "../core/operations.ts";
import { listPermissions } from "../core/permission-registry.ts";
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

/**
 * The approvals block's tenant or platform policy (`options.tenantPolicies`,
 * `options.platformPolicies`). `organizationId` is `null` on a platform policy;
 * `subjectType` and `action` may be `*`.
 */
export type BlockApprovalTenantPolicy = {
  readonly organizationId: string | null;
  readonly subjectType: string;
  readonly action: string;
  readonly effect?: string;
  readonly conditions?: unknown;
  readonly mode: "confirm" | "authorize";
  readonly steps: readonly {
    readonly approvers: BlockApprovalApprovers;
    readonly required: number | "all";
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
      readonly tenantless?: boolean;
    },
  ) => BlockResult<BlockApprovalRecord<I>>;
  readonly list: (options?: {
    readonly status?: BlockStatus | null;
    readonly pageSize?: number;
    readonly before?: I;
    readonly tenantless?: boolean;
  }) => BlockResult<readonly BlockApprovalRecord<I>[]>;
  readonly consume: (
    id: string,
    fingerprint?: string,
  ) => BlockResult<BlockApprovalRecord<I>>;
  readonly approve?: BlockDecide<I>;
  readonly reject?: BlockDecide<I>;
};

export type BlockDecide<I extends BlockInstant> = (
  id: string,
  comment?: string,
  options?: { readonly decidedBy?: string },
) => BlockResult<BlockApprovalRecord<I>>;

/** The call `blockApprovalPolicySource` makes on the approvals block. */
export type BlockApprovalPoliciesClient = {
  readonly listPolicies: (options?: {
    readonly subjectType?: string;
    readonly pageSize?: number;
    readonly platform?: boolean;
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
  tenantless: boolean,
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
        ...(tenantless ? { tenantless } : {}),
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

export type BlockApprovalStoreOptions = { readonly tenantless?: boolean };

type Pair<I extends BlockInstant> = {
  readonly record: BlockApprovalRecord<I>;
  readonly request: ApprovalRequest;
};

/**
 * An `ApprovalStore` over better-supabase's approvals block, so a PermDock
 * `approval-required` decision files a block request and is decided in the
 * block's own approve and reject flow. `create` files the request on the
 * resource under the permission's action, with the PermDock request in
 * `payload.permdock` and its `fingerprint`. `get`, `getById` and `list` read
 * the block's latest 2,000 requests in the block's tenant, and with
 * `tenantless` the latest 2,000 without one. `consume` calls the block's
 * `consume`, which refuses a second use and another fingerprint. `resolve`
 * checks the verdict against the PermDock request, then calls the block's
 * `approve` or `reject` with `decidedBy` set to the approver, so a service-role
 * client records the user who decided; without `approve` and `reject` on the
 * client it throws. `expire` answers 0, since the block expires requests
 * itself.
 */
export function blockApprovalStore<I extends BlockInstant>(
  approvals: BlockApprovalsClient<I>,
  options: BlockApprovalStoreOptions = {},
): ApprovalStore {
  const tenantless = options.tenantless === true;
  const scanAll = async (
    found: (pair: Pair<I>) => boolean,
  ): Promise<readonly Pair<I>[]> => {
    const inTenant = await scan(approvals, found, false);
    if (!tenantless || inTenant.some(found)) {
      return inTenant;
    }
    return [...inTenant, ...(await scan(approvals, found, true))];
  };
  const byToken = async (token: string): Promise<Pair<I> | undefined> =>
    (await scanAll(({ request }) => request.token === token)).find(
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
            tenantless:
              tenantless &&
              decisionTenant(request.subject, request.membership) === undefined
                ? true
                : undefined,
          }),
        ),
        "request",
      );
    },
    async get(token: string): Promise<ApprovalRequest | null> {
      return (await byToken(token))?.request ?? null;
    },
    async getById(id: string): Promise<ApprovalRequest | null> {
      const pairs = await scanAll(({ request }) => request.id === id);
      return pairs.find(({ request }) => request.id === id)?.request ?? null;
    },
    async resolve(
      token: string,
      verdict: ApprovalVerdict,
    ): Promise<ApprovalRequest> {
      const decide =
        verdict.status === "approved" ? approvals.approve : approvals.reject;
      if (decide === undefined) {
        throw new Error(
          "PermDock: blockApprovalStore resolves only with the approvals block's approve and reject on the client",
        );
      }
      const found = await byToken(token);
      if (found === undefined) {
        throw new ApprovalError("approval-not-found", "approval was not found");
      }
      applyApprovalVerdict(found.request, verdict);
      const by = verdict.by.principal?.id;
      const decided = await unwrap(
        decide(found.record.id, verdict.note, compact({ decidedBy: by })),
        verdict.status === "approved" ? "approve" : "reject",
      );
      const next = requestOf(decided);
      if (next === null) {
        throw new ApprovalError("approval-not-found", "approval was not found");
      }
      return next;
    },
    async list(query: ApprovalListQuery): Promise<ApprovalPage> {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const offset = query.cursor === undefined ? 0 : Number(query.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return { items: [] };
      }
      const all = (await scanAll(() => false))
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

function quorumOf(step: BlockApprovalTenantPolicy["steps"][number]): number {
  if (step.required !== "all") {
    return step.required;
  }
  const { users = [], permission, role, team, manager } = step.approvers;
  if (
    users.length === 0 ||
    permission !== undefined ||
    role !== undefined ||
    team !== undefined ||
    manager === true
  ) {
    throw new TypeError(
      'PermDock: an approval policy step with required "all" needs users and no other approvers, since the block counts other holders when a request is filed',
    );
  }
  return users.length;
}

const NUMERIC = /^-?\d+(?:\.\d+)?$/u;

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function variants(value: Scalar): readonly Scalar[] {
  if (typeof value === "string" && NUMERIC.test(value)) {
    return [value, Number(value)];
  }
  return typeof value === "number" ? [value, String(value)] : [value];
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return typeof value === "string" && NUMERIC.test(value)
    ? Number(value)
    : undefined;
}

const ORDER = { gt: "gt", gte: "gte", lt: "lt", lte: "lte" } as const;

function ruleCondition(
  field: string,
  operator: string,
  value: unknown,
): Condition | true | undefined {
  const list = Array.isArray(value) && value.every(isScalar) ? value : [];
  const contains = (item: Scalar): Condition => ({
    op: "contains",
    field,
    value: item,
  });
  switch (operator) {
    case "":
      return true;
    case "is":
    case "eq":
      return isScalar(value)
        ? {
            op: "or",
            conditions: variants(value).map((item) => ({
              op: "eq",
              field,
              value: item,
            })),
          }
        : undefined;
    case "is_not":
    case "neq":
      return isScalar(value)
        ? {
            op: "and",
            conditions: variants(value).map((item) => ({
              op: "ne",
              field,
              value: item,
            })),
          }
        : undefined;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const bound = numberOf(value);
      return bound === undefined
        ? undefined
        : { op: ORDER[operator], field, value: bound };
    }
    case "between":
    case "not_between": {
      const [low, high] = Array.isArray(value)
        ? value.map(numberOf)
        : [undefined, undefined];
      if (low === undefined || high === undefined) {
        return undefined;
      }
      const between: Condition = {
        op: "and",
        conditions: [
          { op: "gte", field, value: low },
          { op: "lte", field, value: high },
        ],
      };
      return operator === "between"
        ? between
        : { op: "not", condition: between };
    }
    case "is_any_of":
    case "is_none_of":
      return list.length === 0
        ? undefined
        : {
            op: operator === "is_any_of" ? "in" : "notIn",
            field,
            value: list.flatMap(variants),
          };
    case "contains":
      return typeof value === "string" ? contains(value) : undefined;
    case "not_contains":
      return typeof value === "string"
        ? { op: "not", condition: contains(value) }
        : undefined;
    case "has_any_of":
    case "has_all_of":
    case "has_none_of": {
      if (list.length === 0) {
        return undefined;
      }
      const each = list.map(contains);
      if (operator === "has_all_of") {
        return { op: "and", conditions: each };
      }
      const any: Condition = { op: "or", conditions: each };
      return operator === "has_any_of" ? any : { op: "not", condition: any };
    }
    case "empty":
      return { op: "isNull", field, value: true };
    case "not_empty":
      return { op: "isNull", field, value: false };
    default:
      return undefined;
  }
}

function treeCondition(node: unknown): Condition | true | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  let condition: Condition | true | undefined;
  if (node["type"] === "group") {
    const rules = node["rules"];
    const combinator = node["combinator"];
    if (
      !Array.isArray(rules) ||
      (combinator !== "and" && combinator !== "or")
    ) {
      return undefined;
    }
    const parts: Condition[] = [];
    for (const rule of rules) {
      const part = treeCondition(rule);
      if (part === undefined) {
        return undefined;
      }
      if (part === true) {
        if (combinator === "or") {
          return true;
        }
        continue;
      }
      parts.push(part);
    }
    condition =
      parts.length === 0 ? true : { op: combinator, conditions: parts };
  } else if (node["type"] === "rule") {
    const path = node["path"];
    const operator = node["operator"];
    if (
      !Array.isArray(path) ||
      path.length !== 1 ||
      typeof path[0] !== "string" ||
      typeof operator !== "string"
    ) {
      return undefined;
    }
    condition = ruleCondition(path[0], operator, node["value"]);
  }
  if (node["negated"] !== true || condition === undefined) {
    return condition;
  }
  return condition === true ? undefined : { op: "not", condition };
}

export type BlockApprovalPolicySourceOptions = {
  /** The scope a step's `role` is held in. Default `tenant`. */
  readonly roleScope?: string;
  readonly platform?: boolean;
  readonly permissions?: PermissionTree;
  readonly effects?: Readonly<Record<string, readonly OperationEffect[]>>;
};

function effectsOf(
  effect: string | undefined,
  options: BlockApprovalPolicySourceOptions,
): readonly OperationEffect[] | undefined {
  if (effect === undefined) {
    return undefined;
  }
  const mapped =
    options.effects !== undefined && Object.hasOwn(options.effects, effect)
      ? options.effects[effect]
      : undefined;
  if (mapped !== undefined) {
    return mapped.length === 0 ? undefined : mapped;
  }
  return isOperationEffect(effect) ? [effect] : undefined;
}

function keysOf(
  entry: BlockApprovalTenantPolicy,
  permissions: PermissionTree | undefined,
): readonly string[] {
  if (permissions === undefined) {
    throw new TypeError(
      "PermDock: an approval policy for every subject type or action needs blockApprovalPolicySource's permissions, or an effect PermDock knows",
    );
  }
  return listPermissions(permissions)
    .map((permission) => permission.key)
    .filter((key) => {
      const dot = key.lastIndexOf(".");
      return (
        dot > 0 &&
        (entry.subjectType === "*" ||
          key.slice(0, dot) === entry.subjectType) &&
        (entry.action === "*" || key.slice(dot + 1) === entry.action)
      );
    });
}

function policiesOf(
  entry: BlockApprovalTenantPolicy,
  options: BlockApprovalPolicySourceOptions,
): readonly ApprovalPolicy[] {
  const roleScope = options.roleScope ?? "tenant";
  const approval: ApprovalOption = compact({
    stages:
      entry.steps.length === 0
        ? undefined
        : entry.steps.map((step) => ({
            by: stageApprovers(step.approvers, roleScope),
            quorum: quorumOf(step),
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
  const tree =
    entry.conditions === undefined || entry.conditions === null
      ? true
      : treeCondition(entry.conditions);
  const shared = compact<ApprovalPolicy>({
    tenant: entry.organizationId ?? undefined,
    check: tree === true || tree === undefined ? undefined : tree,
    approval,
  });
  const wildcard = entry.subjectType === "*" || entry.action === "*";
  if (!wildcard) {
    return [{ ...shared, permission: `${entry.subjectType}.${entry.action}` }];
  }
  const effects = effectsOf(entry.effect, options);
  if (effects !== undefined) {
    return [{ ...shared, effects }];
  }
  return keysOf(entry, options.permissions).map((permission) => ({
    ...shared,
    permission,
  }));
}

function enabledIn(
  tenants: readonly string[],
): (entry: unknown) => entry is BlockApprovalTenantPolicy {
  return (entry: unknown): entry is BlockApprovalTenantPolicy =>
    isRecord(entry) &&
    entry["enabled"] === true &&
    (entry["organizationId"] === null ||
      (typeof entry["organizationId"] === "string" &&
        tenants.includes(entry["organizationId"])));
}

async function listed(
  approvals: BlockApprovalPoliciesClient,
  platform: boolean,
): Promise<readonly unknown[]> {
  const entries: unknown = await unwrap(
    approvals.listPolicies(
      platform ? { pageSize: 200, platform } : { pageSize: 200 },
    ),
    "listPolicies",
  );
  if (!Array.isArray(entries)) {
    throw new TypeError("PermDock: listPolicies answered no list");
  }
  return entries.map((entry: unknown) => entry);
}

/**
 * An `ApprovalPolicySource` over the approvals block's tenant policies, and
 * with `platform` its platform policies, so a PermDock decision asks for
 * approval wherever the block would. A policy keys the permission
 * `<subjectType>.<action>`; a platform policy has no tenant. Its steps become
 * sequential stages whose approvers are any of the step's permission, role,
 * users and manager; `required: "all"` over users needs each of them. `confirm`
 * with `selfApproval` lets the principal approve; `expiresIn` caps the
 * request's `ttl`. `conditions` become a `check` over the call's input, or the
 * row without one; a tree PermDock cannot express is dropped, so the policy
 * applies to every call: stricter, never looser. A `*` subject type or action
 * with an effect PermDock knows matches every operation with that effect, and
 * without one expands over `permissions`. A concrete policy's `effect` is
 * ignored, so it applies to every call of its permission. A step with only a
 * `team` approver, `required: "all"` over anything but users, an interval it
 * cannot read or a failed read makes the source fail, and every call an allow
 * would grant denies.
 */
export function blockApprovalPolicySource(
  approvals: BlockApprovalPoliciesClient,
  options: BlockApprovalPolicySourceOptions = {},
): ApprovalPolicySource {
  return Object.freeze({
    name: "better-supabase-approvals",
    async approvalPoliciesFor(query: {
      readonly tenants: readonly string[];
    }): Promise<readonly ApprovalPolicy[]> {
      const [own, platform] = await Promise.all([
        listed(approvals, false),
        options.platform === true ? listed(approvals, true) : [],
      ]);
      return [...platform, ...own]
        .filter(enabledIn(query.tenants))
        .flatMap((entry) => policiesOf(entry, options));
    },
  });
}
