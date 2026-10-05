import type { Condition } from "../conditions/ast.ts";
import type { AuthEvent } from "./interfaces.ts";
import type {
  ApprovalOption,
  ApprovalRequirement,
  ApprovalStage,
  Grant,
  Policy,
} from "./policy.ts";
import type { Subject } from "./subject.ts";

import { evaluateCondition } from "../conditions/evaluate.ts";
import { normalizeWhere } from "../conditions/normalize.ts";
import { compact } from "./compact.ts";
import { parseDuration } from "./duration.ts";
import { authenticated } from "./grantee.ts";
import { isPortableCondition } from "./hosted.ts";
import { findPermission } from "./permissions.ts";
import { assertApprovalRelations, normalizeApproval } from "./policy.ts";
import { type Scope, rootMembershipId } from "./scopes.ts";
import { isThenable } from "./thenable.ts";

/**
 * One approval requirement kept as data, for a tenant or the whole platform.
 * It adds to what the code requires and never removes a requirement.
 */
export type ApprovalPolicy = {
  /** The permission key; a former key from `renamed` resolves. */
  readonly permission: string;
  /** Absent: every tenant. */
  readonly tenant?: string;
  /** Actor kinds it applies to (`['agent']`); absent: every call. A call without an actor never matches a list. */
  readonly actors?: readonly string[];
  /** A portable condition over the row; instance permissions only, since a collection action has no row. */
  readonly where?: Condition;
  /** A portable condition over the call's input (the proposed row). */
  readonly check?: Condition;
  /** The same shape as `allow(..., { approval })`, without `escalation`. */
  readonly approval: ApprovalOption;
};

/**
 * Data-driven approval requirements, a subject input like `RoleSource`:
 * read once per instance for the subject's tenants (entries without a
 * tenant always apply). A throw, a rejected promise or an invalid entry
 * denies every call an allow would otherwise permit.
 */
export type ApprovalPolicySource = {
  approvalPoliciesFor(query: {
    readonly tenants: readonly string[];
  }): readonly ApprovalPolicy[] | Promise<readonly ApprovalPolicy[]>;
};

export function memoryApprovalPolicies(
  policies: readonly ApprovalPolicy[],
): ApprovalPolicySource {
  const entries = [...policies];
  return Object.freeze({
    approvalPoliciesFor(query: {
      readonly tenants: readonly string[];
    }): readonly ApprovalPolicy[] {
      return entries.filter(
        (entry) =>
          entry.tenant === undefined || query.tenants.includes(entry.tenant),
      );
    },
  });
}

/** An entry checked against the policy and ready to match. */
export type LoadedApprovalPolicy = {
  readonly permission: string;
  readonly tenant?: string;
  readonly actors?: ReadonlySet<string>;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval: NonNullable<Grant["approval"]>;
};

/** `"failed"`: the source threw or returned something that cannot be applied. */
export type LoadedApprovalPolicies = readonly LoadedApprovalPolicy[] | "failed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Why an `ApprovalPolicy` entry does not load. `unknown-permission`: the
 * policy declares no such key (the entry applies to nothing). `invalid`: a
 * field has the wrong shape or the approval option does not normalise.
 * `where-on-collection`: `where` reads a row, which a collection action
 * never has, so the entry could never match; use `check` over the input.
 * `stale-on-without-version`: `staleOn` needs an instance permission whose
 * resource declares `version`.
 */
export type ApprovalPolicyProblem =
  | "unknown-permission"
  | "invalid"
  | "where-on-collection"
  | "stale-on-without-version";

export type ApprovalPolicyValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: ApprovalPolicyProblem };

type Checked =
  | { readonly entry: LoadedApprovalPolicy }
  | { readonly problem: ApprovalPolicyProblem };

function checkOne(policy: Policy, raw: unknown): Checked {
  if (!isRecord(raw) || typeof raw["permission"] !== "string") {
    return { problem: "invalid" };
  }
  const permission = findPermission(policy.permissions, raw["permission"]);
  if (permission === undefined) {
    return { problem: "unknown-permission" };
  }
  const { tenant, actors, where, check, approval } = raw;
  if (
    (tenant !== undefined && typeof tenant !== "string") ||
    (actors !== undefined && !isStringList(actors)) ||
    (where !== undefined && !isPortableCondition(where)) ||
    (check !== undefined && !isPortableCondition(check)) ||
    (isRecord(approval) && approval["escalation"] !== undefined) ||
    (approval !== "human" && !isRecord(approval))
  ) {
    return { problem: "invalid" };
  }
  if (where !== undefined && permission.kind !== "instance") {
    return { problem: "where-on-collection" };
  }
  let normalized: Grant["approval"];
  try {
    // SAFETY: approval is "human" or a record; normalizeApproval throws on any field it cannot accept.
    normalized = normalizeApproval(approval as ApprovalOption, permission.key);
    if (normalized !== undefined) {
      assertApprovalRelations(
        [{ permission, approval: normalized }],
        policy.resources,
      );
    }
  } catch {
    return { problem: "invalid" };
  }
  if (normalized === undefined) {
    return { problem: "invalid" };
  }
  if (
    normalized !== "human" &&
    normalized.staleOn !== undefined &&
    (permission.kind !== "instance" ||
      policy.resources.get(permission.resource)?.version === undefined)
  ) {
    return { problem: "stale-on-without-version" };
  }
  return {
    entry: compact<LoadedApprovalPolicy>({
      permission: permission.key,
      tenant,
      actors: actors === undefined ? undefined : new Set(actors),
      where: where === undefined ? undefined : normalizeWhere(where),
      check: check === undefined ? undefined : normalizeWhere(check),
      approval: normalized,
    }),
  };
}

/**
 * Checks one entry against the policy the way `approvalPoliciesFor` loads
 * it, for an application to refuse a bad entry when it is saved instead of
 * finding every call denied. Never throws.
 */
export function validateApprovalPolicy(
  policy: Policy,
  entry: unknown,
): ApprovalPolicyValidation {
  try {
    const checked = checkOne(policy, entry);
    return "problem" in checked
      ? { ok: false, problem: checked.problem }
      : { ok: true };
  } catch {
    return { ok: false, problem: "invalid" };
  }
}

/**
 * One raw entry checked against the policy: `null` when it names no
 * permission the policy declares (it applies to nothing), `undefined` when
 * it does not load.
 */
function loadOne(
  policy: Policy,
  raw: unknown,
): LoadedApprovalPolicy | null | undefined {
  const checked = checkOne(policy, raw);
  if ("entry" in checked) {
    return checked.entry;
  }
  return checked.problem === "unknown-permission" ? null : undefined;
}

function loadAll(policy: Policy, raw: unknown): LoadedApprovalPolicies {
  if (!Array.isArray(raw)) {
    return "failed";
  }
  const out: LoadedApprovalPolicy[] = [];
  for (const item of raw) {
    const loaded = loadOne(policy, item);
    if (loaded === undefined) {
      return "failed";
    }
    if (loaded !== null) {
      out.push(loaded);
    }
  }
  return out;
}

/** Reads the source once for `tenants`; a throw or an invalid entry loads as `"failed"`. */
export function approvalPoliciesFor(
  policy: Policy,
  source: ApprovalPolicySource | undefined,
  tenants: readonly string[],
  auth: AuthEvent[],
): LoadedApprovalPolicies | Promise<LoadedApprovalPolicies> | undefined {
  if (source === undefined) {
    return undefined;
  }
  const threw = (): "failed" => {
    auth.push({ reason: "source-threw", source: "approvalPolicies" });
    return "failed";
  };
  let raw: unknown;
  try {
    raw = source.approvalPoliciesFor({ tenants });
  } catch {
    return threw();
  }
  if (isThenable(raw)) {
    return Promise.resolve(raw).then((value) => loadAll(policy, value), threw);
  }
  return loadAll(policy, raw);
}

function matches(
  entry: LoadedApprovalPolicy,
  tenant: string | undefined,
  subject: Subject,
  current: unknown,
  next: unknown,
  now: number,
  scopes: readonly Scope[],
): boolean {
  if (entry.tenant !== undefined && entry.tenant !== tenant) {
    return false;
  }
  if (
    entry.actors !== undefined &&
    (subject.actor === undefined || !entry.actors.has(subject.actor.kind))
  ) {
    return false;
  }
  if (
    entry.where !== undefined &&
    !evaluateCondition(entry.where, current, subject, now, scopes)
  ) {
    return false;
  }
  return (
    entry.check === undefined ||
    evaluateCondition(entry.check, next ?? current, subject, now, scopes)
  );
}

function asStages(
  approval: NonNullable<Grant["approval"]>,
): readonly ApprovalStage[] {
  if (approval === "human") {
    return [{ by: authenticated() }];
  }
  if (approval.stages !== undefined) {
    return approval.stages;
  }
  return [
    compact<ApprovalStage>({
      by: approval.by ?? authenticated(),
      quorum: approval.quorum,
    }),
  ];
}

function shorter(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return (parseDuration(b) ?? Infinity) < (parseDuration(a) ?? Infinity)
    ? b
    : a;
}

/**
 * `code` with every matching entry added as further stages: the result
 * needs all of them (`'sequential'` when any part is ordered), keeps the
 * code's escalation, the shortest `ttl`, and `distinct` unless every part
 * opts out. Without a matching entry, `code` unchanged.
 */
export function tightenApproval(
  code: Grant["approval"],
  entries: readonly LoadedApprovalPolicy[],
  input: {
    readonly permission: string;
    readonly tenant: string | undefined;
    readonly subject: Subject;
    readonly current: unknown;
    readonly next: unknown;
    readonly now: number;
    readonly scopes: readonly Scope[];
  },
): Grant["approval"] {
  const extra = entries.filter(
    (entry) =>
      entry.permission === input.permission &&
      matches(
        entry,
        input.tenant,
        input.subject,
        input.current,
        input.next,
        input.now,
        input.scopes,
      ),
  );
  if (extra.length === 0) {
    return code;
  }
  const parts = [
    ...(code === undefined ? [] : [code]),
    ...extra.map((entry) => entry.approval),
  ];
  const stages: ApprovalStage[] = [];
  const seen = new Set<string>();
  let sequential = false;
  let distinct = false;
  let staleOn: ApprovalRequirement["staleOn"];
  let ttl: string | undefined;
  for (const part of parts) {
    for (const stage of asStages(part)) {
      const key = JSON.stringify(stage);
      if (!seen.has(key)) {
        seen.add(key);
        stages.push(stage);
      }
    }
    if (part === "human") {
      distinct = true;
      continue;
    }
    sequential ||= part.mode === "sequential";
    distinct ||= part.distinct !== false;
    staleOn ??= part.staleOn;
    ttl = shorter(ttl, part.ttl);
  }
  return compact<ApprovalRequirement>({
    mode: sequential ? "sequential" : "all",
    stages,
    distinct: distinct ? undefined : false,
    staleOn,
    ttl,
    escalation:
      code === undefined || code === "human" ? undefined : code.escalation,
  });
}

/** The tenant a matched allow applies in: its membership's root scope, else the active tenant. */
export function decisionTenant(
  subject: Subject,
  membership: Parameters<typeof rootMembershipId>[0] | undefined,
): string | undefined {
  return (
    (membership === undefined ? undefined : rootMembershipId(membership)) ??
    subject.principal?.tenant
  );
}
