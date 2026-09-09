import type { SnapshotGrant, SnapshotV2, TokenSigner } from './interfaces.ts';
import type { Grant } from './policy.ts';
import type { Membership, Subject } from './subject.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { isForbiddenKey } from './paths.ts';
import { tenantsOf } from './tenancy.ts';

function snapshotGrant(
  grant: Grant,
  membership: Membership | undefined,
): SnapshotGrant {
  const scope =
    grant.scope === 'global'
      ? undefined
      : grant.scope === 'tenant' || grant.scope === 'team'
        ? grant.scope
        : { resource: grant.scope.resource };
  const entry = compact<SnapshotGrant>({
    permission: grant.permission.key,
    effect: grant.effect,
    role: grant.role,
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

export function buildSnapshot(input: {
  readonly subject: Subject;
  readonly roles: readonly string[];
  readonly grants: readonly {
    readonly grant: Grant;
    readonly membership?: Membership;
  }[];
  readonly include?: readonly string[];
  readonly tenants?: 'all' | undefined;
  readonly simulated?: boolean;
  readonly now?: number;
}): SnapshotV2 {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const principal = input.subject.principal;
  const allTenants = tenantsOf(principal);
  const tenants =
    input.tenants === 'all'
      ? allTenants
      : principal?.tenant === undefined
        ? []
        : [principal.tenant];
  const include = input.include;
  const grants = input.grants
    .filter((item) => {
      if (include === undefined || include.length === 0) {
        return true;
      }
      return include.some(
        (prefix) =>
          item.grant.permission.key === prefix ||
          item.grant.permission.key.startsWith(`${prefix}.`) ||
          item.grant.permission.resource === prefix,
      );
    })
    .map((item) => snapshotGrant(item.grant, item.membership));
  const snapshot = freezeDeep(
    compact<SnapshotV2>({
      v: 2 as const,
      issuedAt: now,
      subject: compact<SnapshotV2['subject']>({
        principal:
          principal === null
            ? null
            : compact<NonNullable<SnapshotV2['subject']['principal']>>({
                id: principal.id,
                roles: principal.roles ?? [],
                tenant: principal.tenant,
                memberships: principal.memberships,
              }),
        delegation: input.subject.delegation,
        context: input.subject.context,
      }),
      roles: input.roles,
      grants,
      tenants,
      include,
      simulated: input.simulated === true ? true : undefined,
      expiresAt: input.subject.expiresAt,
    }),
  );
  return snapshot;
}

export async function signSnapshot(
  snapshot: SnapshotV2,
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

export function parseSnapshot(json: unknown): SnapshotV2 {
  const value = typeof json === 'string' ? (JSON.parse(json) as unknown) : json;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PermDock: snapshot must be an object');
  }
  rejectUnsafe(value, '$');
  const record = value as Record<string, unknown>;
  const version = record.v;
  if (version !== 1 && version !== 2) {
    throw new Error(
      `PermDock: unsupported snapshot version '${String(version)}'`,
    );
  }
  return freezeDeep(value) as SnapshotV2;
}
