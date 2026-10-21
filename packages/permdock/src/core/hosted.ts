import type { Condition, ConditionValue } from "../conditions/ast.ts";
import type { ApprovalRequirement, Grant, Policy } from "./policy-types.ts";

import { normalizeWhere } from "../conditions/normalize.ts";
import { compact, isRecord } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { allow, completeGrant, deny } from "./grant-builders.ts";
import { type Grantee, MAX_RELATION_DEPTH, flattenGrantee } from "./grantee.ts";
import { isForbiddenKey, splitPath } from "./paths.ts";
import { findPermission, getResource } from "./permission-registry.ts";
import { declaredRoleNames, indexPolicy } from "./policy.ts";
import { isSelfParented } from "./resource-relations.ts";
import { role } from "./role-builder.ts";
import { sha256Digest } from "./sha256.ts";
import { durationOf } from "./time.ts";
import { isRfc3339, rfc3339 } from "./time.ts";
import { findRole, listPlans } from "./vocabulary.ts";

/**
 * One grant authored in PermDock Cloud; its grantee is a declared role, plan or
 * relation.
 */
export type HostedGrant = {
  readonly id: string;
  readonly permission: string;
  readonly effect?: "allow" | "deny";
  readonly to: Grantee | readonly Grantee[];
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human" | ApprovalRequirement;
  readonly fields?: readonly string[];
};

/**
 * PolicyDocument v1. Signed as a `vnd.permdock.policy+jwt`, the `policy` claim
 * carries every field but `id` and `issuedAt`, which are the token's `jti` and
 * `iat` (`policyDocumentFromClaims`).
 */
export type PolicyDocument = {
  readonly v: 1;
  readonly id: string;
  readonly fingerprint: string;
  /** The catalog fingerprint the document was authored against. */
  readonly catalog: string;
  /** RFC 3339. */
  readonly issuedAt: string;
  readonly grants: readonly HostedGrant[];
};

/**
 * The channel for hosted grants. `getPermDock` reads `current()` once; the
 * application calls `refresh()` on its own schedule, never a check.
 */
export type PolicySource = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  current(): PolicyDocument | null;
  refresh(): Promise<void>;
};

export type HostedGrantDropReason =
  | "not-hostable"
  | "unknown-permission"
  | "unknown-grantee"
  | "non-portable"
  | "weaker-approval"
  | "invalid";

/**
 * Reported through `on('error')` when a hosted grant is not merged; never
 * thrown.
 */
export type HostedGrantDropped = {
  readonly kind: "hosted-grant-dropped";
  readonly document: string;
  readonly grant: string;
  readonly reason: HostedGrantDropReason;
};

export function memoryPolicySource(
  document: PolicyDocument | null = null,
): PolicySource {
  const current = document === null ? null : parsePolicyDocument(document);
  return Object.freeze({
    current: (): PolicyDocument | null => current,
    refresh: (): Promise<void> => Promise.resolve(),
  });
}

function rejectUnsafe(value: unknown): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      rejectUnsafe(item);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) {
      throw new Error(`PermDock: unsafe policy document key '${key}'`);
    }
    // SAFETY: arrays and primitives returned above; key is an own key of this object.
    rejectUnsafe((value as Record<string, unknown>)[key]);
  }
}

/** Validates the document envelope; per-grant checks happen at merge time. */
export function parsePolicyDocument(json: unknown): PolicyDocument {
  const input: unknown = typeof json === "string" ? JSON.parse(json) : json;
  if (!isRecord(input)) {
    throw new TypeError("PermDock: policy document must be an object");
  }
  // SAFETY: a JSON round trip of a record checked by isRecord above is again a plain object.
  const copy = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  rejectUnsafe(copy);
  if (copy["v"] !== 1) {
    throw new Error(
      `PermDock: unsupported policy document version '${String(copy["v"])}'`,
    );
  }
  if (
    typeof copy["id"] !== "string" ||
    typeof copy["fingerprint"] !== "string" ||
    typeof copy["catalog"] !== "string" ||
    !isRfc3339(copy["issuedAt"]) ||
    !Array.isArray(copy["grants"])
  ) {
    throw new TypeError("PermDock: malformed policy document");
  }
  // SAFETY: the envelope fields are checked above; each grant is checked by buildGrant at merge.
  return freezeDeep(copy) as unknown as PolicyDocument;
}

/**
 * The document verified `vnd.permdock.policy+jwt` claims carry: `policy`, with
 * `jti` as `id` and `iat` as `issuedAt`. Throws like `parsePolicyDocument`.
 */
export function policyDocumentFromClaims(
  claims: Readonly<Record<string, unknown>>,
): PolicyDocument {
  const claim = claims["policy"];
  const jti = claims["jti"];
  const iat = claims["iat"];
  if (!isRecord(claim) || typeof jti !== "string" || typeof iat !== "number") {
    throw new TypeError("PermDock: malformed policy document");
  }
  return parsePolicyDocument({ ...claim, id: jti, issuedAt: rfc3339(iat) });
}

const COMPARISONS: ReadonlySet<string> = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
]);

function safePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) {
    return false;
  }
  return splitPath(path).every((segment) => !isForbiddenKey(segment));
}

function portableValue(value: unknown): value is ConditionValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(portableValue);
  }
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return false;
  }
  if (keys[0] === "ref") {
    return safePath(value["ref"]);
  }
  return keys[0] === "date" && typeof value["date"] === "string";
}

/**
 * True for the portable subset only: no `opaque`, no `sqlFunction`, no unknown
 * op.
 */
export function isPortableCondition(value: unknown): value is Condition {
  if (!isRecord(value) || typeof value["op"] !== "string") {
    return false;
  }
  const op = value["op"];
  if (COMPARISONS.has(op)) {
    return safePath(value["field"]) && portableValue(value["value"]);
  }
  switch (op) {
    case "in":
    case "notIn":
      return (
        safePath(value["field"]) &&
        (Array.isArray(value["value"]) || isRecord(value["value"])) &&
        portableValue(value["value"])
      );
    case "isNull":
      return safePath(value["field"]) && typeof value["value"] === "boolean";
    case "and":
    case "or":
      return (
        Array.isArray(value["conditions"]) &&
        value["conditions"].every(isPortableCondition)
      );
    case "not":
      return isPortableCondition(value["condition"]);
    case "memberOf":
      return (
        (value["scope"] === "tenant" ||
          value["scope"] === "team" ||
          value["scope"] === "resource") &&
        safePath(value["field"]) &&
        Array.isArray(value["roles"]) &&
        value["roles"].every((item) => typeof item === "string") &&
        (value["resource"] === undefined ||
          typeof value["resource"] === "string") &&
        (value["parents"] === undefined ||
          (Array.isArray(value["parents"]) &&
            value["parents"].every(
              (parent) =>
                safePath(parent) ||
                (isRecord(parent) &&
                  safePath(parent["field"]) &&
                  typeof parent["resource"] === "string"),
            )))
      );
    default:
      return false;
  }
}

function approvalRank(
  approval: Grant["approval"],
):
  | {
      readonly by?: string;
      readonly distinct: boolean;
      readonly stale: boolean;
      readonly quorum: number;
      readonly ttl: number;
      readonly escalates: boolean;
    }
  | undefined {
  if (approval === undefined) {
    return undefined;
  }
  if (approval === "human") {
    return {
      distinct: true,
      stale: false,
      quorum: 1,
      ttl: Number.POSITIVE_INFINITY,
      escalates: false,
    };
  }
  return {
    by:
      approval.stages === undefined
        ? JSON.stringify(approval.by)
        : JSON.stringify([approval.mode, approval.stages]),
    distinct: approval.distinct !== false,
    stale: approval.staleOn === "resource-change",
    quorum: approval.quorum ?? 1,
    ttl: durationOf(approval.ttl) ?? Number.POSITIVE_INFINITY,
    escalates: approval.escalation !== undefined,
  };
}

/**
 * A hosted approval must meet every approval a code allow requires on the
 * permission.
 */
function approvalAtLeast(
  hosted: Grant["approval"],
  code: readonly Grant["approval"][],
): boolean {
  const mine = approvalRank(hosted);
  for (const required of code) {
    const theirs = approvalRank(required);
    if (theirs === undefined) {
      continue;
    }
    if (mine === undefined) {
      return false;
    }
    if (theirs.distinct && !mine.distinct) {
      return false;
    }
    if (theirs.stale && !mine.stale) {
      return false;
    }
    if (theirs.by !== undefined && mine.by !== theirs.by) {
      return false;
    }
    // Fewer approvers, a longer wait or a wider approver set is weaker.
    if (mine.quorum < theirs.quorum || mine.ttl > theirs.ttl) {
      return false;
    }
    if (mine.escalates && !theirs.escalates) {
      return false;
    }
  }
  return true;
}

/**
 * A grantee kind this build does not know is never declared, so the hosted
 * grant is dropped.
 */
function undeclaredKind(_grantee: never): false {
  return false;
}

/**
 * Whether a hosted grant may name `grantee` on a permission of
 * `permissionResource`.
 */
export function declaredGrantee(
  policy: Policy,
  grantee: Grantee,
  permissionResource: string,
): boolean {
  switch (grantee.kind) {
    case "role":
      return declaredRoleNames(policy).has(grantee.role);
    case "plan":
      return listPlans(policy.vocabulary.plans).some(
        (leaf) => leaf.key === grantee.plan,
      );
    case "relation":
      return (
        grantee.resource === permissionResource &&
        getResource(policy.permissions, grantee.resource)?.relations[
          grantee.relation
        ] !== undefined &&
        (grantee.through === undefined ||
          (grantee.through === "parent" &&
            isSelfParented(
              getResource(policy.permissions, grantee.resource),
            ))) &&
        (grantee.depth === undefined ||
          (grantee.through === "parent" &&
            Number.isInteger(grantee.depth) &&
            grantee.depth >= 0 &&
            grantee.depth <= MAX_RELATION_DEPTH))
      );
    case "anyone":
    case "authenticated":
    case "actor":
    case "assurance":
    case "inherit":
      return false;
    default: {
      const exhaustive: never = grantee;
      return undeclaredKind(exhaustive);
    }
  }
}

/** Approvers are declared roles, plans or relations, or any authenticated human. */
function approvalAcceptable(
  policy: Policy,
  approval: unknown,
  permissionResource: string,
): boolean {
  if (approval === undefined || approval === "human") {
    return true;
  }
  if (!isRecord(approval)) {
    return false;
  }
  if (approval["mode"] !== undefined || approval["stages"] !== undefined) {
    return false;
  }
  if (
    approval["distinct"] !== undefined &&
    typeof approval["distinct"] !== "boolean"
  ) {
    return false;
  }
  if (
    approval["staleOn"] !== undefined &&
    (approval["staleOn"] !== "resource-change" ||
      getResource(policy.permissions, permissionResource)?.version ===
        undefined)
  ) {
    return false;
  }
  if (
    approval["quorum"] !== undefined &&
    (!Number.isInteger(approval["quorum"]) ||
      // SAFETY: Number.isInteger just established that quorum is a number.
      (approval["quorum"] as number) < 1)
  ) {
    return false;
  }
  if (
    approval["ttl"] !== undefined &&
    durationOf(approval["ttl"]) === undefined
  ) {
    return false;
  }
  const escalation = approval["escalation"];
  if (
    escalation !== undefined &&
    (!isRecord(escalation) ||
      durationOf(escalation["after"]) === undefined ||
      !granteesAcceptable(policy, escalation["to"], permissionResource))
  ) {
    return false;
  }
  if (approval["by"] === undefined) {
    return true;
  }
  return granteesAcceptable(policy, approval["by"], permissionResource);
}

function granteesAcceptable(
  policy: Policy,
  raw: unknown,
  permissionResource: string,
): boolean {
  if (raw === undefined) {
    return false;
  }
  // SAFETY: each item is checked with isRecord and declaredGrantee below before it is trusted.
  const items = flattenGrantee(raw as Grantee | readonly Grantee[]);
  return (
    items.length > 0 &&
    items.every(
      (item) =>
        isRecord(item) &&
        item.kind !== "relation" &&
        (item.kind === "authenticated" ||
          declaredGrantee(policy, item, permissionResource)),
    )
  );
}

/**
 * The approvals the code allows on `key` carry; a hosted allow must meet each
 * one.
 */
export function codeApprovals(
  policy: Policy,
  key: string,
): readonly Grant["approval"][] {
  return policy.grants
    .filter(
      (grant) =>
        grant.effect === "allow" &&
        grant.hosted === undefined &&
        grant.permission.key === key,
    )
    .map((grant) => grant.approval);
}

type Built =
  | { readonly ok: true; readonly grant: Grant }
  | { readonly ok: false; readonly reason: HostedGrantDropReason };

function buildGrant(
  policy: Policy,
  document: PolicyDocument,
  raw: unknown,
): Built {
  if (
    !isRecord(raw) ||
    typeof raw["id"] !== "string" ||
    typeof raw["permission"] !== "string" ||
    (raw["effect"] !== undefined &&
      raw["effect"] !== "allow" &&
      raw["effect"] !== "deny") ||
    raw["to"] === undefined
  ) {
    return { ok: false, reason: "invalid" };
  }
  const permission = findPermission(policy.permissions, raw["permission"]);
  if (permission === undefined) {
    return { ok: false, reason: "unknown-permission" };
  }
  if (!policy.hostable.includes(permission.key)) {
    return { ok: false, reason: "not-hostable" };
  }
  // SAFETY: each item is checked with isRecord and declaredGrantee below before it is trusted.
  const to = flattenGrantee(raw["to"] as Grantee | readonly Grantee[]);
  if (
    to.length === 0 ||
    !to.every(
      (item) =>
        isRecord(item) && declaredGrantee(policy, item, permission.resource),
    )
  ) {
    return { ok: false, reason: "unknown-grantee" };
  }
  for (const condition of [raw["where"], raw["check"]]) {
    if (condition !== undefined && !isPortableCondition(condition)) {
      return { ok: false, reason: "non-portable" };
    }
  }
  if (!approvalAcceptable(policy, raw["approval"], permission.resource)) {
    return { ok: false, reason: "invalid" };
  }
  if (
    raw["fields"] !== undefined &&
    !(
      Array.isArray(raw["fields"]) &&
      raw["fields"].every((field) => typeof field === "string")
    )
  ) {
    return { ok: false, reason: "invalid" };
  }
  const effect = raw["effect"] ?? "allow";
  // SAFETY: approval passed approvalAcceptable and fields was checked as a string list above.
  const options = compact({
    where:
      raw["where"] === undefined ? undefined : normalizeWhere(raw["where"]),
    check:
      raw["check"] === undefined ? undefined : normalizeWhere(raw["check"]),
    approval: raw["approval"] as Grant["approval"],
    fields: raw["fields"] as readonly string[] | undefined,
  });
  let built: Grant;
  try {
    const roleItem = to.length === 1 && to[0]?.kind === "role" ? to[0] : null;
    if (roleItem === null) {
      // SAFETY: to and options were validated above; allow and deny are generic over the leaf.
      const partial = (effect === "allow" ? allow : deny)(permission, {
        ...options,
        to,
      } as never);
      // SAFETY: allow and deny return a grant without role and scope, which completeGrant adds.
      built = completeGrant(partial as Omit<Grant, "role" | "scope">);
    } else {
      const binding = policy.rolesByName.get(roleItem.role);
      const leaf = findRole(policy.vocabulary.roles, roleItem.role);
      // SAFETY: options were validated above; allow and deny are generic over the leaf.
      const bound = role(
        leaf ?? roleItem.role,
        [(effect === "allow" ? allow : deny)(permission, options as never)],
        binding?.on === undefined ? {} : { on: binding.on },
      );
      const [first] = bound.grants;
      if (first === undefined) {
        throw new TypeError("PermDock: role produced no grant");
      }
      built = first;
    }
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    effect === "allow" &&
    !approvalAtLeast(built.approval, codeApprovals(policy, permission.key))
  ) {
    return { ok: false, reason: "weaker-approval" };
  }
  return {
    ok: true,
    grant: freezeDeep({
      ...built,
      hosted: { document: document.fingerprint, grant: raw["id"] },
    }),
  };
}

export type HostedGrantCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: HostedGrantDropReason };

const CHECKED_DOCUMENT: PolicyDocument = Object.freeze({
  v: 1,
  id: "",
  fingerprint: "",
  catalog: "",
  issuedAt: "",
  grants: Object.freeze([]),
});

/**
 * Whether `mergeHostedGrants` would keep one candidate hosted grant, and the
 * drop reason it would report when not. Needs no `PolicyDocument`, so a grant
 * form can check a grant before it publishes one.
 */
export function checkHostedGrant(
  policy: Policy,
  grant: unknown,
): HostedGrantCheck {
  const result = buildGrant(policy, CHECKED_DOCUMENT, grant);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * One hosted grant `mergeHostedGrants` would drop, with the permission key it
 * names.
 */
export type HostedGrantDrop = {
  readonly grant: string;
  readonly permission: string;
  readonly reason: HostedGrantDropReason;
};

/**
 * The grants of `document` that `policy` drops, in document order;
 * `permdock/catalog` turns them into drift findings.
 */
export function hostedGrantDrops(
  policy: Policy,
  document: PolicyDocument,
): readonly HostedGrantDrop[] {
  return document.grants.flatMap((raw): HostedGrantDrop[] => {
    const result = buildGrant(policy, document, raw);
    if (result.ok) {
      return [];
    }
    return [
      freezeDeep({
        grant: isRecord(raw) && typeof raw.id === "string" ? raw.id : "",
        permission:
          isRecord(raw) && typeof raw.permission === "string"
            ? raw.permission
            : "",
        reason: result.reason,
      }),
    ];
  });
}

/**
 * The code policy plus the hosted grants that pass every rule. Hosted allows OR
 * with code allows and any deny still wins, so a hosted grant can never
 * override a code deny; one that fails a rule is dropped, not thrown.
 */
export function mergeHostedGrants(
  policy: Policy,
  document: PolicyDocument | null,
): {
  readonly policy: Policy;
  readonly dropped: readonly HostedGrantDropped[];
} {
  if (document === null || document.grants.length === 0) {
    return { policy, dropped: [] };
  }
  const merged: Grant[] = [];
  const dropped: HostedGrantDropped[] = [];
  for (const raw of document.grants) {
    const result = buildGrant(policy, document, raw);
    if (result.ok) {
      merged.push(result.grant);
      continue;
    }
    dropped.push(
      freezeDeep({
        kind: "hosted-grant-dropped" as const,
        document: document.fingerprint,
        grant: isRecord(raw) && typeof raw.id === "string" ? raw.id : "",
        reason: result.reason,
      }),
    );
  }
  if (merged.length === 0) {
    return { policy, dropped };
  }
  const grants = [...policy.grants, ...merged];
  return {
    policy: freezeDeep({
      ...policy,
      grants,
      index: indexPolicy(policy.roles, grants, policy.vocabulary),
      fingerprint: sha256Digest(
        `${policy.fingerprint}:${document.fingerprint}`,
      ),
    }),
    dropped,
  };
}

/**
 * Hosted grants as an instance option: `policies: hostedPolicies(source)`. The
 * merge code ships only with an app that imports this function.
 * `source.current()` is read once per instance; a throw keeps the code policy
 * and is reported as an error event.
 */
export type HostedPolicies = {
  readonly feature: "hosted-policies";
  readonly apply: (policy: Policy) => {
    readonly policy: Policy;
    readonly errors: readonly unknown[];
  };
};

export function hostedPolicies(source: PolicySource): HostedPolicies {
  return Object.freeze({
    feature: "hosted-policies" as const,
    apply(policy: Policy) {
      if (policy.hostable.length === 0) {
        return { policy, errors: [] };
      }
      let document: PolicyDocument | null;
      try {
        document = source.current();
      } catch (error) {
        return { policy, errors: [error] };
      }
      const merged = mergeHostedGrants(policy, document);
      return { policy: merged.policy, errors: merged.dropped };
    },
  });
}
