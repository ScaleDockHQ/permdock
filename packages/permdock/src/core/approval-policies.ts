import type { Condition } from "../conditions/ast.ts";
import type { AuthEvent } from "./event-types.ts";
import type { OperationRisk } from "./operation-risks.ts";
import type { OperationEffect, OperationMeta } from "./operations.ts";
import type {
  ApprovalOption,
  ApprovalRequirement,
  ApprovalStage,
  Grant,
  Policy,
} from "./policy-types.ts";
import type { Subject } from "./subject.ts";

import { evaluateCondition } from "../conditions/evaluate.ts";
import { normalizeWhere } from "../conditions/normalize.ts";
import {
  assertApprovalRelations,
  normalizeApproval,
} from "./approval-normalize.ts";
import { compact, isRecord } from "./compact.ts";
import { authenticated } from "./grantee.ts";
import { isPortableCondition } from "./hosted.ts";
import { isOperationRisk } from "./operation-risks.ts";
import { isOperationEffect } from "./operations.ts";
import { findPermission } from "./permission-registry.ts";
import { type Scope, rootMembershipId } from "./scopes.ts";
import { isThenable } from "./thenable.ts";
import { durationOf } from "./time.ts";

/**
 * One approval requirement kept as data, for a tenant or the whole platform.
 * It adds to what the code requires and never removes a requirement.
 */
export type ApprovalPolicy = {
  /**
   * The permission key; a former key from `renamed` resolves. Absent: every
   * permission, which needs `risk` or `effects`.
   */
  readonly permission?: string;
  /** Matches an operation call whose `meta.risk` is one of these; a call that names no operation never matches. */
  readonly risk?: readonly OperationRisk[];
  /** Matches an operation call whose `meta.effects` includes one of these; a call that names no operation never matches. */
  readonly effects?: readonly OperationEffect[];
  /** Absent: every tenant. */
  readonly tenant?: string;
  /** Actor kinds it applies to (`['agent']`); absent: every call. A call without an actor never matches a list. */
  readonly actors?: readonly string[];
  /** A portable condition over the row; instance permissions only, since a collection action has no row. */
  readonly where?: Condition;
  /** A portable condition over the call's input (the proposed row). */
  readonly check?: Condition;
  /**
   * The same shape as `allow(..., { approval })`. An `escalation` here widens
   * only this entry's stages, never the code's.
   */
  readonly approval: ApprovalOption;
};

/**
 * Data-driven approval requirements, a subject input like `CustomRoleSource`:
 * read once per instance for the subject's tenants (entries without a
 * tenant always apply). A throw, a rejected promise or an invalid entry
 * denies every call an allow would otherwise permit.
 */
export type ApprovalPolicySource = {
  approvalPoliciesFor(query: {
    readonly tenants: readonly string[];
  }): readonly ApprovalPolicy[] | Promise<readonly ApprovalPolicy[]>;
};

/** The denial detail when an `ApprovalPolicySource` fails: every call an allow would grant denies with reason `approval`. */
export const APPROVAL_POLICY_UNAVAILABLE = "approval-policy-unavailable";

export function memoryApprovalPolicySource(
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
  readonly permission?: string;
  readonly risk?: ReadonlySet<OperationRisk>;
  readonly effects?: ReadonlySet<OperationEffect>;
  readonly tenant?: string;
  readonly actors?: ReadonlySet<string>;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval: NonNullable<Grant["approval"]>;
};

/** `"failed"`: the source threw or returned something that cannot be applied. */
export type LoadedApprovalPolicies = readonly LoadedApprovalPolicy[] | "failed";

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

function metaList<T>(
  value: unknown,
  is: (item: unknown) => item is T,
): ReadonlySet<T> | undefined | "invalid" {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(is)) {
    return "invalid";
  }
  return new Set(value);
}

/** An entry with no permission, matched on operation meta alone. */
function checkMetaOnly(
  raw: Readonly<Record<string, unknown>>,
  risk: ReadonlySet<OperationRisk> | undefined,
  effects: ReadonlySet<OperationEffect> | undefined,
): Checked {
  const { tenant, actors, where, check, approval } = raw;
  if (
    (risk === undefined && effects === undefined) ||
    where !== undefined ||
    (tenant !== undefined && typeof tenant !== "string") ||
    (actors !== undefined && !isStringList(actors)) ||
    (check !== undefined && !isPortableCondition(check)) ||
    (approval !== "human" && !isRecord(approval))
  ) {
    return { problem: "invalid" };
  }
  let normalized: Grant["approval"];
  try {
    // SAFETY: approval is "human" or a record; normalizeApproval throws on any field it cannot accept.
    normalized = normalizeApproval(approval as ApprovalOption);
  } catch {
    return { problem: "invalid" };
  }
  if (
    normalized === undefined ||
    (normalized !== "human" && normalized.staleOn !== undefined)
  ) {
    return { problem: "invalid" };
  }
  return {
    entry: compact<LoadedApprovalPolicy>({
      risk,
      effects,
      tenant,
      actors: actors === undefined ? undefined : new Set(actors),
      check: check === undefined ? undefined : normalizeWhere(check),
      approval: normalized,
    }),
  };
}

function checkOne(policy: Policy, raw: unknown): Checked {
  if (!isRecord(raw)) {
    return { problem: "invalid" };
  }
  const risk = metaList(raw["risk"], isOperationRisk);
  const effects = metaList(raw["effects"], isOperationEffect);
  if (risk === "invalid" || effects === "invalid") {
    return { problem: "invalid" };
  }
  if (raw["permission"] === undefined) {
    return checkMetaOnly(raw, risk, effects);
  }
  if (typeof raw["permission"] !== "string") {
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
      risk,
      effects,
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

function metaMatches(
  entry: LoadedApprovalPolicy,
  operation: OperationMeta | undefined,
): boolean {
  if (entry.risk === undefined && entry.effects === undefined) {
    return true;
  }
  if (operation === undefined) {
    return false;
  }
  if (
    entry.risk !== undefined &&
    (operation.risk === undefined || !entry.risk.has(operation.risk))
  ) {
    return false;
  }
  const effects = entry.effects;
  return (
    effects === undefined ||
    (operation.effects ?? []).some((effect) => effects.has(effect))
  );
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

/** An entry's stages, each carrying the entry's escalation unless it has its own. */
function entryStages(
  approval: NonNullable<Grant["approval"]>,
): readonly ApprovalStage[] {
  const stages = asStages(approval);
  if (approval === "human" || approval.escalation === undefined) {
    return stages;
  }
  const escalation = approval.escalation;
  return stages.map((stage) =>
    stage.escalation === undefined
      ? compact<ApprovalStage>({
          by: stage.by,
          quorum: stage.quorum,
          escalation,
        })
      : stage,
  );
}

function shorter(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  return (durationOf(b) ?? Infinity) < (durationOf(a) ?? Infinity) ? b : a;
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
    /** The meta of the operation the call decides, when it names one. */
    readonly operation?: OperationMeta | undefined;
  },
): Grant["approval"] {
  const extra = entries.filter(
    (entry) =>
      (entry.permission === undefined ||
        entry.permission === input.permission) &&
      metaMatches(entry, input.operation) &&
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
  let ttl: number | undefined;
  for (const [index, part] of parts.entries()) {
    const fromCode = code !== undefined && index === 0;
    for (const stage of fromCode ? asStages(part) : entryStages(part)) {
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
