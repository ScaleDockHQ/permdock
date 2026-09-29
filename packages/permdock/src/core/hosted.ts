import type { Condition, ConditionValue } from '../conditions/ast.ts';
import type { Grantee } from './grantee.ts';
import type { ApprovalRequirement, Grant, Policy } from './policy.ts';

import { normalizeWhere } from '../conditions/normalize.ts';
import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { flattenGrantee } from './grantee.ts';
import { isForbiddenKey, splitPath } from './paths.ts';
import { findPermission, getResource } from './permissions.ts';
import {
  allow,
  completeGrant,
  declaredRoleNames,
  deny,
  role,
} from './policy.ts';
import { bytesToBase64Url, sha256 } from './sha256.ts';
import { findRole, listPlans } from './vocabulary.ts';

/** One grant authored in PermDock Cloud; its grantee is a declared role, plan or relation. */
export type HostedGrant = {
  readonly id: string;
  readonly permission: string;
  readonly effect?: 'allow' | 'deny';
  readonly to: Grantee | readonly Grantee[];
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: 'human' | ApprovalRequirement;
  readonly fields?: readonly string[];
};

/** PolicyDocument v1: the payload of a `permdock-policy+jwt` under the `policy` claim. */
export type PolicyDocument = {
  readonly v: 1;
  readonly id: string;
  readonly fingerprint: string;
  /** The catalog fingerprint the document was authored against. */
  readonly catalog: string;
  readonly issuedAt: number;
  readonly grants: readonly HostedGrant[];
};

/**
 * The channel for hosted grants. `createPermDock` reads `current()` once;
 * the application calls `refresh()` on its own schedule, never a check.
 */
export type PolicySource = {
  current(): PolicyDocument | null;
  refresh(): Promise<void>;
};

export type HostedGrantDropReason =
  | 'not-hostable'
  | 'unknown-permission'
  | 'unknown-grantee'
  | 'non-portable'
  | 'weaker-approval'
  | 'invalid';

/** Reported through `on('error')` when a hosted grant is not merged; never thrown. */
export type HostedGrantDropped = {
  readonly kind: 'hosted-grant-dropped';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnsafe(value: unknown): void {
  if (value === null || typeof value !== 'object') {
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
    rejectUnsafe((value as Record<string, unknown>)[key]);
  }
}

/** Validates the document envelope; per-grant checks happen at merge time. */
export function parsePolicyDocument(json: unknown): PolicyDocument {
  const input = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  if (!isRecord(input)) {
    throw new TypeError('PermDock: policy document must be an object');
  }
  const copy = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  rejectUnsafe(copy);
  if (copy.v !== 1) {
    throw new Error(
      `PermDock: unsupported policy document version '${String(copy.v)}'`,
    );
  }
  if (
    typeof copy.id !== 'string' ||
    typeof copy.fingerprint !== 'string' ||
    typeof copy.catalog !== 'string' ||
    typeof copy.issuedAt !== 'number' ||
    !Array.isArray(copy.grants)
  ) {
    throw new TypeError('PermDock: malformed policy document');
  }
  return freezeDeep(copy) as unknown as PolicyDocument;
}

const COMPARISONS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains']);

function safePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }
  return splitPath(path).every((segment) => !isForbiddenKey(segment));
}

function portableValue(value: unknown): value is ConditionValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
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
  if (keys[0] === 'ref') {
    return safePath(value.ref);
  }
  return keys[0] === 'date' && typeof value.date === 'string';
}

/** True for the portable subset only: no `opaque`, no `sqlFunction`, no unknown op. */
export function isPortableCondition(value: unknown): value is Condition {
  if (!isRecord(value) || typeof value.op !== 'string') {
    return false;
  }
  const op = value.op;
  if (COMPARISONS.has(op)) {
    return safePath(value.field) && portableValue(value.value);
  }
  switch (op) {
    case 'in':
    case 'notIn':
      return (
        safePath(value.field) &&
        (Array.isArray(value.value) || isRecord(value.value)) &&
        portableValue(value.value)
      );
    case 'isNull':
      return safePath(value.field) && typeof value.value === 'boolean';
    case 'and':
    case 'or':
      return (
        Array.isArray(value.conditions) &&
        value.conditions.every(isPortableCondition)
      );
    case 'not':
      return isPortableCondition(value.condition);
    case 'memberOf':
      return (
        (value.scope === 'tenant' ||
          value.scope === 'team' ||
          value.scope === 'resource') &&
        safePath(value.field) &&
        Array.isArray(value.roles) &&
        value.roles.every((item) => typeof item === 'string') &&
        (value.resource === undefined || typeof value.resource === 'string') &&
        (value.parents === undefined ||
          (Array.isArray(value.parents) &&
            value.parents.every(
              (parent) =>
                safePath(parent) ||
                (isRecord(parent) &&
                  safePath(parent.field) &&
                  typeof parent.resource === 'string'),
            )))
      );
    default:
      return false;
  }
}

function approvalRank(approval: Grant['approval']):
  | {
      readonly by?: string;
      readonly distinct: boolean;
      readonly stale: boolean;
    }
  | undefined {
  if (approval === undefined) {
    return undefined;
  }
  if (approval === 'human') {
    return { distinct: true, stale: false };
  }
  return {
    by: JSON.stringify(approval.by),
    distinct: approval.distinct !== false,
    stale: approval.staleOn === 'resource-change',
  };
}

/** A hosted approval must meet every approval a code allow requires on the permission. */
function approvalAtLeast(
  hosted: Grant['approval'],
  code: readonly Grant['approval'][],
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
  }
  return true;
}

function declaredGrantee(
  policy: Policy,
  grantee: Grantee,
  permissionResource: string,
): boolean {
  switch (grantee.kind) {
    case 'role':
      return declaredRoleNames(policy).has(grantee.role);
    case 'plan':
      return listPlans(policy.vocabulary.plans).some(
        (leaf) => leaf.key === grantee.plan,
      );
    case 'relation':
      return (
        grantee.resource === permissionResource &&
        getResource(policy.permissions, grantee.resource)?.relations[
          grantee.relation
        ] !== undefined
      );
    case 'anyone':
    case 'authenticated':
    case 'actor':
    case 'assurance':
      return false;
    default: {
      const exhaustive: never = grantee;
      return exhaustive;
    }
  }
}

/** Approvers are declared roles, plans or relations, or any authenticated human. */
function approvalAcceptable(
  policy: Policy,
  approval: unknown,
  permissionResource: string,
): boolean {
  if (approval === undefined || approval === 'human') {
    return true;
  }
  if (!isRecord(approval)) {
    return false;
  }
  if (
    approval.distinct !== undefined &&
    typeof approval.distinct !== 'boolean'
  ) {
    return false;
  }
  if (
    approval.staleOn !== undefined &&
    (approval.staleOn !== 'resource-change' ||
      getResource(policy.permissions, permissionResource)?.version ===
        undefined)
  ) {
    return false;
  }
  if (approval.by === undefined) {
    return true;
  }
  const by = flattenGrantee(approval.by as Grantee | readonly Grantee[]);
  return (
    by.length > 0 &&
    by.every(
      (item) =>
        isRecord(item) &&
        (item.kind === 'authenticated' ||
          declaredGrantee(policy, item, permissionResource)),
    )
  );
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
    typeof raw.id !== 'string' ||
    typeof raw.permission !== 'string' ||
    (raw.effect !== undefined &&
      raw.effect !== 'allow' &&
      raw.effect !== 'deny') ||
    raw.to === undefined
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const permission = findPermission(policy.permissions, raw.permission);
  if (permission === undefined) {
    return { ok: false, reason: 'unknown-permission' };
  }
  if (!policy.hostable.includes(permission.key)) {
    return { ok: false, reason: 'not-hostable' };
  }
  const to = flattenGrantee(raw.to as Grantee | readonly Grantee[]);
  if (
    to.length === 0 ||
    !to.every(
      (item) =>
        isRecord(item) && declaredGrantee(policy, item, permission.resource),
    )
  ) {
    return { ok: false, reason: 'unknown-grantee' };
  }
  for (const condition of [raw.where, raw.check]) {
    if (condition !== undefined && !isPortableCondition(condition)) {
      return { ok: false, reason: 'non-portable' };
    }
  }
  if (!approvalAcceptable(policy, raw.approval, permission.resource)) {
    return { ok: false, reason: 'invalid' };
  }
  if (
    raw.fields !== undefined &&
    !(
      Array.isArray(raw.fields) &&
      raw.fields.every((field) => typeof field === 'string')
    )
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const effect = raw.effect ?? 'allow';
  const options = compact({
    where:
      raw.where === undefined
        ? undefined
        : normalizeWhere(raw.where as Condition),
    check:
      raw.check === undefined
        ? undefined
        : normalizeWhere(raw.check as Condition),
    approval: raw.approval as Grant['approval'],
    fields: raw.fields as readonly string[] | undefined,
  });
  let built: Grant;
  try {
    const roleItem = to.length === 1 && to[0]?.kind === 'role' ? to[0] : null;
    if (roleItem === null) {
      const partial = (effect === 'allow' ? allow : deny)(permission, {
        ...options,
        to,
      } as never);
      built = completeGrant(partial as Omit<Grant, 'role' | 'scope'>);
    } else {
      const binding = policy.rolesByName.get(roleItem.role);
      const leaf = findRole(policy.vocabulary.roles, roleItem.role);
      const bound = role(
        leaf ?? roleItem.role,
        [(effect === 'allow' ? allow : deny)(permission, options as never)],
        binding?.on === undefined ? {} : { on: binding.on },
      );
      built = bound.grants[0]!;
    }
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (effect === 'allow') {
    const codeApprovals = policy.grants
      .filter(
        (grant) =>
          grant.effect === 'allow' &&
          grant.hosted === undefined &&
          grant.permission.key === permission.key,
      )
      .map((grant) => grant.approval);
    if (!approvalAtLeast(built.approval, codeApprovals)) {
      return { ok: false, reason: 'weaker-approval' };
    }
  }
  return {
    ok: true,
    grant: freezeDeep({
      ...built,
      hosted: { document: document.fingerprint, grant: raw.id },
    }),
  };
}

/**
 * The code policy plus the hosted grants that pass every rule. Hosted
 * allows OR with code allows and any deny still wins, so a hosted grant can
 * never override a code deny; one that fails a rule is dropped, not thrown.
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
        kind: 'hosted-grant-dropped' as const,
        document: document.fingerprint,
        grant: isRecord(raw) && typeof raw.id === 'string' ? raw.id : '',
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
      fingerprint: bytesToBase64Url(
        sha256(`${policy.fingerprint}:${document.fingerprint}`),
      ),
    }),
    dropped,
  };
}
