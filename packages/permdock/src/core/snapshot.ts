import type {
  Snapshot,
  SnapshotAssignable,
  SnapshotGrant,
  SnapshotNotEntitled,
  TokenSigner,
} from './interfaces.ts';
import type { Grant, PolicyVocabulary } from './policy.ts';
import type { Delegation, Membership, Subject } from './subject.ts';

import { bindConditionRefs } from '../conditions/bind.ts';
import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { isForbiddenKey } from './paths.ts';
import { scopeList } from './scopes.ts';
import { tenantsOf } from './tenancy.ts';
import { listPlans, listRoles } from './vocabulary.ts';

export function snapshotGrant(
  grant: Grant,
  membership: Membership | undefined,
): SnapshotGrant {
  const scope =
    grant.scope === 'global'
      ? undefined
      : typeof grant.scope === 'string'
        ? grant.scope
        : { resource: grant.scope.resource };
  const entry = compact<SnapshotGrant>({
    permission: grant.permission.key,
    effect: grant.effect,
    role: grant.role,
    to: grant.to,
    where: grant.portable ? grant.where : undefined,
    check: grant.portable ? grant.check : undefined,
    approval: grant.approval,
    scope,
    membership,
    portable: grant.portable ? undefined : false,
    fields: grant.fields,
  });
  return freezeDeep(entry);
}

/** Claim refs: the snapshot principal does not carry `claims`, so they are bound to the subject's values. */
function isClaimRef(ref: string): boolean {
  return (
    ref.startsWith('principal.claim.') || ref.startsWith('principal.claims.')
  );
}

function bindClaims(grant: SnapshotGrant, subject: Subject): SnapshotGrant {
  if (grant.where === undefined && grant.check === undefined) {
    return grant;
  }
  return freezeDeep(
    compact<SnapshotGrant>({
      ...grant,
      where:
        grant.where === undefined
          ? undefined
          : bindConditionRefs(grant.where, subject, isClaimRef),
      check:
        grant.check === undefined
          ? undefined
          : bindConditionRefs(grant.check, subject, isClaimRef),
    }),
  );
}

function notEntitledOf(
  items: readonly { readonly grant: Grant }[],
): readonly SnapshotNotEntitled[] | undefined {
  const seen = new Map<string, SnapshotNotEntitled>();
  for (const { grant } of items) {
    const key = `${grant.permission.key}\u0000${grant.role ?? ''}`;
    if (!seen.has(key)) {
      seen.set(key, {
        permission: grant.permission.key,
        role: grant.role,
        to: grant.to,
      });
    }
  }
  return seen.size === 0 ? undefined : [...seen.values()];
}

export function buildSnapshot(input: {
  readonly subject: Subject;
  readonly roles: readonly string[];
  readonly audiences?: readonly string[];
  readonly grants: readonly {
    readonly grant: Grant;
    readonly membership?: Membership;
  }[];
  readonly include?: readonly string[];
  readonly tenants?: 'all' | undefined;
  readonly simulated?: boolean;
  readonly now?: number;
  readonly vocabulary?: PolicyVocabulary;
  readonly scopes?: Snapshot['scopes'];
  readonly assignable?: (tenant: string) => SnapshotAssignable;
  readonly notEntitled?: readonly { readonly grant: Grant }[];
}): Snapshot {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const principal = input.subject.principal;
  const allTenants = tenantsOf(principal, scopeList(input.scopes));
  const tenants =
    input.tenants === 'all'
      ? allTenants
      : principal?.tenant === undefined
        ? []
        : [principal.tenant];
  const include = input.include;
  const included = (permission: Grant['permission']): boolean =>
    include === undefined ||
    include.length === 0 ||
    include.some(
      (prefix) =>
        permission.key === prefix ||
        permission.key.startsWith(`${prefix}.`) ||
        permission.resource === prefix,
    );
  const grants = input.grants
    .filter((item) => included(item.grant.permission))
    .map((item) =>
      bindClaims(snapshotGrant(item.grant, item.membership), input.subject),
    );
  const assignableFor = input.assignable;
  const assignable =
    assignableFor === undefined
      ? []
      : tenants.map((tenant) => {
          const entry = assignableFor(tenant);
          return {
            ...entry,
            permissions: entry.permissions.filter(included),
          };
        });
  const snapshot = freezeDeep(
    compact<Snapshot>({
      v: 1 as const,
      issuedAt: now,
      subject: compact<Snapshot['subject']>({
        principal:
          principal === null
            ? null
            : compact<NonNullable<Snapshot['subject']['principal']>>({
                id: principal.id,
                roles: principal.roles ?? [],
                plans: principal.plans,
                tenant: principal.tenant,
                memberships: principal.memberships,
              }),
        delegation: snapshotDelegation(input.subject),
        context: input.subject.context,
      }),
      roles: input.roles,
      audiences: input.audiences,
      grants,
      tenants,
      include,
      simulated: input.simulated === true ? true : undefined,
      expiresAt: input.subject.expiresAt,
      scopes: input.scopes,
      assignable: assignable.length > 0 ? assignable : undefined,
      notEntitled: notEntitledOf(
        (input.notEntitled ?? []).filter((item) =>
          included(item.grant.permission),
        ),
      ),
      vocabulary:
        input.vocabulary === undefined
          ? undefined
          : compact<NonNullable<Snapshot['vocabulary']>>({
              roles:
                listRoles(input.vocabulary.roles).length === 0
                  ? undefined
                  : Object.fromEntries(
                      listRoles(input.vocabulary.roles).map((leaf) => [
                        leaf.key,
                        leaf,
                      ]),
                    ),
              plans:
                listPlans(input.vocabulary.plans).length === 0
                  ? undefined
                  : Object.fromEntries(
                      listPlans(input.vocabulary.plans).map((leaf) => [
                        leaf.key,
                        leaf,
                      ]),
                    ),
            }),
    }),
  );
  return snapshot;
}

export async function signSnapshot(
  snapshot: Snapshot,
  signer: TokenSigner,
  audience?: string | readonly string[],
): Promise<string> {
  const payload: Record<string, unknown> = {
    snapshot,
  };
  if (snapshot.subject.principal !== null) {
    payload.sub = snapshot.subject.principal.id;
  }
  const token = await signer.sign(
    payload,
    compact<Parameters<TokenSigner['sign']>[1]>({
      typ: 'permdock-snapshot+jwt' as const,
      audience,
      expiresAt: snapshot.expiresAt,
    }),
  );
  return token;
}

function snapshotDelegation(subject: Subject): Delegation | undefined {
  const delegation = subject.delegation;
  if (subject.actor === undefined) {
    return delegation;
  }
  if (
    delegation?.scopes === undefined &&
    delegation?.authorizationDetails === undefined &&
    delegation?.access === undefined
  ) {
    return { ...delegation, scopes: [] };
  }
  return delegation;
}

function rejectUnsafe(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      rejectUnsafe(item, `${path}[${index}]`);
    }
    return;
  }
  for (const key of Object.keys(value as object)) {
    if (isForbiddenKey(key)) {
      throw new Error(`PermDock: unsafe snapshot key '${key}' at ${path}`);
    }
    rejectUnsafe((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

export function parseSnapshot(json: unknown): Snapshot {
  const input = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('PermDock: snapshot must be an object');
  }
  // Freezing the caller's object in place would break a framework proxy
  // around it (Vue `reactive`, Nuxt `useState`); freeze a plain copy instead.
  const value =
    typeof json === 'string' || Object.isFrozen(input)
      ? input
      : (JSON.parse(JSON.stringify(input)) as object);
  rejectUnsafe(value, '$');
  const record = value as Record<string, unknown>;
  const version = record.v;
  if (version !== 1) {
    throw new Error(
      `PermDock: unsupported snapshot version '${String(version)}'`,
    );
  }
  return freezeDeep(value) as Snapshot;
}
