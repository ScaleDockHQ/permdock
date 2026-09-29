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

export type SignCapabilityOptions = {
  readonly audience?: string | readonly string[];
};

const MAX_ID = 256;
const MAX_ENTRIES = 64;

/** A copy holding only own enumerable properties, so a prototype never supplies a field. */
function ownRecord(value: unknown): Record<string, unknown> | undefined {
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

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_ID
  );
}

function idList(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ENTRIES ||
    !value.every(isId)
  ) {
    return undefined;
  }
  return [...new Set(value as readonly string[])];
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
  if (keys.length === 1 && isId(value.user)) {
    return { user: value.user };
  }
  if (keys.length === 2 && isId(value.scope) && isId(value.id)) {
    return { scope: value.scope, id: value.id };
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
  if (value === undefined || value.v !== 1 || !isId(value.id)) {
    return undefined;
  }
  if (value.holder !== 'link' && value.holder !== 'key') {
    return undefined;
  }
  const on = ownRecord(value.on);
  if (on === undefined || !isId(on.resource) || !isId(on.id)) {
    return undefined;
  }
  const roles = idList(value.roles);
  if (roles === undefined) {
    return undefined;
  }
  const permissions =
    value.permissions === undefined ? undefined : idList(value.permissions);
  if (value.permissions !== undefined && permissions === undefined) {
    return undefined;
  }
  const redeemer =
    value.redeemer === undefined ? undefined : parseRedeemer(value.redeemer);
  if (value.redeemer !== undefined && redeemer === undefined) {
    return undefined;
  }
  if (value.once !== undefined && value.once !== true) {
    return undefined;
  }
  const expiresAt = value.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return undefined;
  }
  return freezeDeep(
    compact<Capability>({
      v: 1,
      id: value.id,
      holder: value.holder,
      on: { resource: on.resource, id: on.id },
      roles,
      permissions,
      redeemer,
      once: value.once,
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
