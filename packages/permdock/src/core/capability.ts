import type { TokenSigner } from './interfaces.ts';
import type { Permission, PermissionTree } from './permissions.ts';
import type { Membership, Principal, Subject } from './subject.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { isForbiddenKey } from './paths.ts';
import { listPermissions } from './permissions.ts';
import { anonymousSubject } from './subject.ts';

/**
 * Who may redeem a capability: anyone holding it, any signed-in principal,
 * one user, or a member of one scope instance. The viewer is the request's
 * own verified subject, never a claim of the capability.
 */
export type CapabilityRedeemer =
  | 'anyone'
  | 'signed-in'
  | { readonly user: string }
  | { readonly scope: string; readonly id: string };

/**
 * Capability v1: the `capability` claim of a `permdock-capability+jwt`. It
 * holds `roles` on one resource instance (`on`, the `Membership.on` shape),
 * optionally narrowed to `permissions` (keys). `id` is the link id: the
 * token's `sub` and the handle an application revokes.
 */
export type Capability = {
  readonly v: 1;
  readonly id: string;
  /** `key` is reserved for user-bound credentials and resolves to no subject. */
  readonly holder: 'link' | 'key';
  readonly on: { readonly resource: string; readonly id: string };
  readonly roles: readonly string[];
  readonly permissions?: readonly string[];
  readonly redeemer?: CapabilityRedeemer;
  /** One request per token: the resolver claims the token's `jti` in a `ReplayStore`. */
  readonly once?: true;
  /** Seconds since the epoch; also the token's `exp` and the membership's `expiresAt`. */
  readonly expiresAt: number;
};

export type LinkPrincipal = Principal & {
  readonly kind: 'link';
  readonly capability: Capability;
};

export type CapabilityInput = {
  readonly id: string;
  readonly on: {
    readonly resource: Permission | PermissionTree;
    readonly id: string;
  };
  readonly roles: readonly string[];
  readonly permissions?: readonly Permission[];
  readonly redeemer?: CapabilityRedeemer;
  readonly once?: boolean;
  readonly expiresAt: number;
};

/**
 * What one scope instance (a tenant, a customer) allows for links on its
 * resources. Every field only tightens; several policies must all hold.
 */
export type LinkPolicy = {
  /** Longest a link may live, in seconds from when it was issued. */
  readonly maxLifetime?: number;
  /** Redeemer kinds allowed; `anyone` also covers a capability without `redeemer`. */
  readonly redeemers?: readonly ('anyone' | 'signed-in' | 'user' | 'scope')[];
  /** Every link must be one-time. */
  readonly once?: boolean;
};

export type LinkPolicyViolation = 'lifetime' | 'redeemer' | 'once';

export type SignCapabilityOptions = {
  readonly audience?: string | readonly string[];
  /** Refuse to sign a link these policies would refuse at resolution. */
  readonly linkPolicy?: LinkPolicy | readonly LinkPolicy[];
};

function redeemerKind(
  redeemer: CapabilityRedeemer | undefined,
): 'anyone' | 'signed-in' | 'user' | 'scope' {
  if (redeemer === undefined || typeof redeemer === 'string') {
    return redeemer ?? 'anyone';
  }
  return 'user' in redeemer ? 'user' : 'scope';
}

/**
 * The first rule of `policy` the capability breaks, or `undefined`. A
 * lifetime rule without a known `issuedAt`, or one that is not a finite
 * non-negative number, is broken: the check fails closed.
 */
export function linkPolicyViolation(
  capability: Capability,
  policy: LinkPolicy | readonly LinkPolicy[],
  issuedAt: number | undefined,
): LinkPolicyViolation | undefined {
  // SAFETY: Array.isArray does not narrow a readonly array out of the union; not an array here.
  const policies: readonly LinkPolicy[] = Array.isArray(policy)
    ? policy
    : [policy as LinkPolicy];
  for (const item of policies) {
    const max = item.maxLifetime;
    if (
      max !== undefined &&
      (typeof max !== 'number' ||
        !Number.isFinite(max) ||
        max < 0 ||
        issuedAt === undefined ||
        capability.expiresAt - issuedAt > max)
    ) {
      return 'lifetime';
    }
    if (
      item.redeemers !== undefined &&
      !item.redeemers.includes(redeemerKind(capability.redeemer))
    ) {
      return 'redeemer';
    }
    if (item.once === true && capability.once !== true) {
      return 'once';
    }
  }
  return undefined;
}

const MAX_ID = 256;
const MAX_ENTRIES = 64;

/** A copy holding only own enumerable properties, so a prototype never supplies a field. */
export function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isForbiddenKey(key)) {
      record[key] = item;
    }
  }
  return record;
}

export function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_ID
  );
}

export function idList(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ENTRIES ||
    !value.every(isId)
  ) {
    return undefined;
  }
  return [...new Set(value)];
}

function parseRedeemer(input: unknown): CapabilityRedeemer | undefined {
  if (input === 'anyone' || input === 'signed-in') {
    return input;
  }
  const value = ownRecord(input);
  if (value === undefined) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && isId(value['user'])) {
    return { user: value['user'] };
  }
  if (keys.length === 2 && isId(value['scope']) && isId(value['id'])) {
    return { scope: value['scope'], id: value['id'] };
  }
  return undefined;
}

/**
 * Validates an untrusted `capability` claim and returns a frozen copy with
 * only the v1 fields, or `undefined`. Unknown fields are dropped; a wrong
 * type in a known field rejects the whole claim.
 */
export function parseCapability(input: unknown): Capability | undefined {
  const value = ownRecord(input);
  if (value === undefined || value['v'] !== 1 || !isId(value['id'])) {
    return undefined;
  }
  if (value['holder'] !== 'link' && value['holder'] !== 'key') {
    return undefined;
  }
  const on = ownRecord(value['on']);
  if (on === undefined || !isId(on['resource']) || !isId(on['id'])) {
    return undefined;
  }
  const roles = idList(value['roles']);
  if (roles === undefined) {
    return undefined;
  }
  const permissions =
    value['permissions'] === undefined
      ? undefined
      : idList(value['permissions']);
  if (value['permissions'] !== undefined && permissions === undefined) {
    return undefined;
  }
  const redeemer =
    value['redeemer'] === undefined
      ? undefined
      : parseRedeemer(value['redeemer']);
  if (value['redeemer'] !== undefined && redeemer === undefined) {
    return undefined;
  }
  if (value['once'] !== undefined && value['once'] !== true) {
    return undefined;
  }
  const expiresAt = value['expiresAt'];
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return undefined;
  }
  return freezeDeep(
    compact<Capability>({
      v: 1,
      id: value['id'],
      holder: value['holder'],
      on: { resource: on['resource'], id: on['id'] },
      roles,
      permissions,
      redeemer,
      once: value['once'],
      expiresAt,
    }),
  );
}

function resourceName(resource: Permission | PermissionTree): string {
  const names = new Set(listPermissions(resource).map((leaf) => leaf.resource));
  const [name] = names;
  if (names.size !== 1 || name === undefined) {
    throw new Error(
      'PermDock: capability on.resource must name exactly one resource',
    );
  }
  return name;
}

/** Builds the v1 `Capability` for `input`; throws on an input no resolver would accept. */
export function capabilityOf(input: CapabilityInput): Capability {
  const capability = parseCapability(
    compact({
      v: 1,
      id: input.id,
      holder: 'link',
      on: { resource: resourceName(input.on.resource), id: input.on.id },
      roles: input.roles,
      permissions: input.permissions?.map((permission) => permission.key),
      redeemer: input.redeemer,
      once: input.once === true ? true : undefined,
      expiresAt: Math.floor(input.expiresAt),
    }),
  );
  if (capability === undefined) {
    throw new Error(
      'PermDock: invalid capability (id, on.id and roles are required; roles and permissions hold at most 64 entries)',
    );
  }
  return capability;
}

/**
 * Signs a capability as a `permdock-capability+jwt`: `sub` is the link id,
 * `exp` is `expiresAt`, and the signer sets `iss`, `iat` and a fresh `jti`.
 */
export function signCapability(
  input: CapabilityInput,
  signer: TokenSigner,
  options: SignCapabilityOptions = {},
): Promise<string> {
  const capability = capabilityOf(input);
  const violation =
    options.linkPolicy === undefined
      ? undefined
      : linkPolicyViolation(
          capability,
          options.linkPolicy,
          Math.floor(Date.now() / 1000),
        );
  if (violation !== undefined) {
    return Promise.reject(
      new Error(`PermDock: capability breaks the link policy (${violation})`),
    );
  }
  return signer.sign(
    { capability, sub: capability.id },
    compact<Parameters<TokenSigner['sign']>[1]>({
      typ: 'permdock-capability+jwt',
      audience: options.audience,
      expiresAt: capability.expiresAt,
    }),
  );
}

function holdsScope(
  membership: Membership,
  scope: string,
  id: string,
  now: number,
): boolean {
  if (membership.expiresAt !== undefined && membership.expiresAt <= now) {
    return false;
  }
  if (membership.scope === scope && membership.id === id) {
    return true;
  }
  return (
    (scope === 'tenant' && membership.tenant === id) ||
    (scope === 'team' && membership.team === id)
  );
}

/** Whether `viewer`, the request's own verified subject, may redeem a capability. */
export function redeemerAllows(
  redeemer: CapabilityRedeemer | undefined,
  viewer: Subject | undefined,
  now: number = Date.now() / 1000,
): boolean {
  if (redeemer === undefined || redeemer === 'anyone') {
    return true;
  }
  const principal = viewer?.principal ?? null;
  if (principal === null || principal.kind === 'link') {
    return false;
  }
  if (redeemer === 'signed-in') {
    return true;
  }
  if ('user' in redeemer) {
    return principal.id === redeemer.user;
  }
  return (principal.memberships ?? []).some((membership) =>
    holdsScope(membership, redeemer.scope, redeemer.id, now),
  );
}

/**
 * The subject a verified capability acts as: a `link` principal holding
 * `roles` on `on` and nothing else, with `delegation.scopes` narrowing it to
 * `permissions` when the capability lists them. A `key` holder resolves to
 * the anonymous subject until user-bound credentials ship.
 */
export function capabilitySubject(
  capability: Capability,
  options: { readonly issuer?: string } = {},
): Subject<LinkPrincipal> | Subject {
  if (capability.holder !== 'link') {
    return anonymousSubject();
  }
  const membership: Membership = {
    on: capability.on,
    roles: capability.roles,
    via: 'link',
    expiresAt: capability.expiresAt,
  };
  const principal: LinkPrincipal = compact<LinkPrincipal>({
    id: capability.id,
    kind: 'link',
    issuer: options.issuer,
    memberships: [membership],
    capability,
  });
  return freezeDeep(
    compact<Subject<LinkPrincipal>>({
      principal,
      delegation:
        capability.permissions === undefined
          ? undefined
          : {
              scopes: capability.permissions.map((key) =>
                key.replaceAll('.', ':'),
              ),
            },
      context: {},
      expiresAt: capability.expiresAt,
    }),
  );
}
