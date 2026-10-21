import type { TokenSigner } from "./interfaces.ts";
import type { Permission, PermissionTree } from "./permission-types.ts";
import type { Membership, Principal, Subject } from "./subject.ts";
import type { Instant } from "./time.ts";

import { compact } from "./compact.ts";
import { expiredAt } from "./expiry.ts";
import { freezeDeep } from "./freeze.ts";
import { idList, isId, sameId } from "./ids.ts";
import { ownRecord } from "./paths.ts";
import { listPermissions } from "./permission-registry.ts";
import { anonymousSubject } from "./subject.ts";
import { epochSeconds, nowSeconds } from "./time.ts";

/**
 * Who may redeem a capability: anyone holding it, any signed-in principal, one
 * user, or a member of one scope instance. The viewer is the request's own
 * verified subject, never a claim of the capability.
 */
export type CapabilityRedeemer =
  | "anyone"
  | "signed-in"
  | { readonly user: string }
  | { readonly scope: string; readonly id: string };

/**
 * RFC 7800 confirmation: the SHA-256 JWK thumbprint (RFC 7638) of the key that
 * must redeem it.
 */
export type CapabilityConfirmation = { readonly jkt: string };

/**
 * Capability v1: the `capability` claim of a `vnd.permdock.capability+jwt`. It
 * holds `roles` on one resource instance (`on`, the `Membership.on` shape),
 * optionally narrowed to `permissions` (keys). The link id is the token's `sub`
 * and its expiry the token's `exp`; neither repeats here.
 */
export type CapabilityClaim = {
  readonly v: 1;
  /** `key` is reserved for user-bound credentials and resolves to no subject. */
  readonly holder: "link" | "key";
  readonly on: { readonly resource: string; readonly id: string };
  readonly roles: readonly string[];
  readonly permissions?: readonly string[];
  readonly redeemer?: CapabilityRedeemer;
  /**
   * One request per token: the resolver claims the token's `jti` in a
   * `ReplayStore`.
   */
  readonly once?: true;
};

/**
 * A verified capability: the claim plus `id` (the token's `sub`, the handle an
 * application revokes), `expiresAt` (its `exp`, Unix seconds, also the
 * membership's `expiresAt`) and `cnf` when the token binds a redeemer key.
 */
export type Capability = CapabilityClaim & {
  readonly id: string;
  readonly expiresAt: number;
  readonly cnf?: CapabilityConfirmation;
};

export type CapabilityPrincipal = Principal & {
  readonly kind: "link";
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
  /** `exp`, Unix seconds. */
  readonly expiresAt: number;
  /**
   * Binds the link to the key with this RFC 7638 thumbprint; redeeming it then
   * needs a DPoP proof from that key.
   */
  readonly cnf?: CapabilityConfirmation;
};

/**
 * What one scope instance (a tenant, a customer) allows for links on its
 * resources. Every field only tightens; several policies must all hold.
 */
export type LinkPolicy = {
  /** Longest a link may live, in seconds from when it was issued. */
  readonly maxLifetime?: number;
  /**
   * Redeemer kinds allowed; `anyone` also covers a capability without
   * `redeemer`.
   */
  readonly redeemers?: readonly ("anyone" | "signed-in" | "user" | "scope")[];
  /** Every link must be one-time. */
  readonly once?: boolean;
};

export type LinkPolicyViolation = "lifetime" | "redeemer" | "once";

export type CapabilityOptions = {
  readonly audience?: string | readonly string[];
  /** `iat`; the clock when absent. */
  readonly issuedAt?: Instant;
  /** Refuse to sign a link these policies would refuse at resolution. */
  readonly linkPolicy?: LinkPolicy | readonly LinkPolicy[];
};

function redeemerKind(
  redeemer: CapabilityRedeemer | undefined,
): "anyone" | "signed-in" | "user" | "scope" {
  if (redeemer === undefined || typeof redeemer === "string") {
    return redeemer ?? "anyone";
  }
  return "user" in redeemer ? "user" : "scope";
}

/**
 * The first rule of `policy` the capability breaks, or `undefined`. A lifetime
 * rule without a known `issuedAt`, or one that is not a finite non-negative
 * number, is broken: the check fails closed.
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
      (typeof max !== "number" ||
        !Number.isFinite(max) ||
        max < 0 ||
        issuedAt === undefined ||
        capability.expiresAt - issuedAt > max)
    ) {
      return "lifetime";
    }
    if (
      item.redeemers !== undefined &&
      !item.redeemers.includes(redeemerKind(capability.redeemer))
    ) {
      return "redeemer";
    }
    if (item.once === true && capability.once !== true) {
      return "once";
    }
  }
  return undefined;
}

function parseRedeemer(input: unknown): CapabilityRedeemer | undefined {
  if (input === "anyone" || input === "signed-in") {
    return input;
  }
  const value = ownRecord(input);
  if (value === undefined) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && isId(value["user"])) {
    return { user: value["user"] };
  }
  if (keys.length === 2 && isId(value["scope"]) && isId(value["id"])) {
    return { scope: value["scope"], id: value["id"] };
  }
  return undefined;
}

function parseConfirmation(input: unknown): CapabilityConfirmation | undefined {
  const value = ownRecord(input);
  const jkt = value?.["jkt"];
  return typeof jkt === "string" && /^[\w-]{43}$/u.test(jkt)
    ? { jkt }
    : undefined;
}

/**
 * Validates a verified capability (a claim plus `id`, `expiresAt` and an
 * optional `cnf`) and returns a frozen copy, or `undefined`.
 */
export function parseCapability(input: unknown): Capability | undefined {
  const value = ownRecord(input);
  const claim = parseCapabilityClaim(input);
  if (value === undefined || claim === undefined || !isId(value["id"])) {
    return undefined;
  }
  const expiresAt = value["expiresAt"];
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return undefined;
  }
  const cnf =
    value["cnf"] === undefined ? undefined : parseConfirmation(value["cnf"]);
  if (value["cnf"] !== undefined && cnf === undefined) {
    return undefined;
  }
  return freezeDeep(
    compact<Capability>({ ...claim, id: value["id"], expiresAt, cnf }),
  );
}

/**
 * The capability verified claims carry: the `capability` claim, `sub` as `id`,
 * `exp` as `expiresAt` and the RFC 7800 `cnf`. `undefined` when any of them is
 * missing or malformed.
 */
export function capabilityFromClaims(
  claims: Readonly<Record<string, unknown>>,
): Capability | undefined {
  const claim = parseCapabilityClaim(claims["capability"]);
  const sub = claims["sub"];
  const exp = claims["exp"];
  if (claim === undefined || !isId(sub) || typeof exp !== "number") {
    return undefined;
  }
  return parseCapability({
    ...claim,
    id: sub,
    expiresAt: exp,
    cnf: claims["cnf"],
  });
}

/**
 * Validates an untrusted `capability` claim and returns a frozen copy with only
 * the v1 fields, or `undefined`. Unknown fields are dropped; a wrong type in a
 * known field rejects the whole claim.
 */
export function parseCapabilityClaim(
  input: unknown,
): CapabilityClaim | undefined {
  const value = ownRecord(input);
  if (value === undefined || value["v"] !== 1) {
    return undefined;
  }
  if (value["holder"] !== "link" && value["holder"] !== "key") {
    return undefined;
  }
  const on = ownRecord(value["on"]);
  if (on === undefined || !isId(on["resource"]) || !isId(on["id"])) {
    return undefined;
  }
  const roles = idList(value["roles"]);
  if (roles === undefined) {
    return undefined;
  }
  const permissions =
    value["permissions"] === undefined
      ? undefined
      : idList(value["permissions"]);
  if (value["permissions"] !== undefined && permissions === undefined) {
    return undefined;
  }
  const redeemer =
    value["redeemer"] === undefined
      ? undefined
      : parseRedeemer(value["redeemer"]);
  if (value["redeemer"] !== undefined && redeemer === undefined) {
    return undefined;
  }
  if (value["once"] !== undefined && value["once"] !== true) {
    return undefined;
  }
  return freezeDeep(
    compact<CapabilityClaim>({
      v: 1,
      holder: value["holder"],
      on: { resource: on["resource"], id: on["id"] },
      roles,
      permissions,
      redeemer,
      once: value["once"],
    }),
  );
}

function resourceName(resource: Permission | PermissionTree): string {
  const names = new Set(listPermissions(resource).map((leaf) => leaf.resource));
  const [name] = names;
  if (names.size !== 1 || name === undefined) {
    throw new Error(
      "PermDock: capability on.resource must name exactly one resource",
    );
  }
  return name;
}

/**
 * Builds the v1 `Capability` for `input`; throws on an input no resolver would
 * accept.
 */
export function capabilityOf(input: CapabilityInput): Capability {
  const capability = parseCapability(
    compact({
      v: 1,
      id: input.id,
      holder: "link",
      on: { resource: resourceName(input.on.resource), id: input.on.id },
      roles: input.roles,
      permissions: input.permissions?.map((permission) => permission.key),
      redeemer: input.redeemer,
      once: input.once === true ? true : undefined,
      expiresAt: Math.floor(input.expiresAt),
      cnf: input.cnf,
    }),
  );
  if (capability === undefined) {
    throw new Error(
      "PermDock: invalid capability (id, on.id and roles are required; roles and permissions hold at most 64 entries; cnf.jkt is a base64url SHA-256 thumbprint)",
    );
  }
  return capability;
}

/**
 * Signs a capability as a `vnd.permdock.capability+jwt`: `sub` is the link id,
 * `exp` is `expiresAt`, `cnf` binds the redeemer's key, and the signer sets
 * `iss`, `aud`, `iat` (`issuedAt`, else now) and a fresh `jti`.
 */
export function signCapability(
  input: CapabilityInput,
  signer: TokenSigner,
  options: CapabilityOptions = {},
): Promise<string> {
  const capability = capabilityOf(input);
  const issuedAt = nowSeconds(options.issuedAt);
  const violation =
    options.linkPolicy === undefined
      ? undefined
      : linkPolicyViolation(capability, options.linkPolicy, issuedAt);
  if (violation !== undefined) {
    return Promise.reject(
      new Error(`PermDock: capability breaks the link policy (${violation})`),
    );
  }
  const { id, expiresAt, cnf, ...claim } = capability;
  return signer.sign(
    compact({ capability: claim, sub: id, cnf }),
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: "vnd.permdock.capability+jwt",
      audience: options.audience,
      expiresAt,
      issuedAt,
    }),
  );
}

function holdsScope(
  membership: Membership,
  scope: string,
  id: string,
  now: number,
): boolean {
  if (expiredAt(membership, now)) {
    return false;
  }
  if (membership.scope === scope && sameId(membership.id, id)) {
    return true;
  }
  return (
    (scope === "tenant" && sameId(membership.tenant, id)) ||
    (scope === "team" && sameId(membership.team, id))
  );
}

/**
 * Whether `viewer`, the request's own verified subject, may redeem a
 * capability.
 */
export function redeemerAllows(
  redeemer: CapabilityRedeemer | undefined,
  viewer: Subject | undefined,
  now: number = epochSeconds(),
): boolean {
  if (redeemer === undefined || redeemer === "anyone") {
    return true;
  }
  const principal = viewer?.principal ?? null;
  if (
    principal === null ||
    principal.kind === "link" ||
    principal.kind === "feed"
  ) {
    return false;
  }
  if (redeemer === "signed-in") {
    return true;
  }
  if ("user" in redeemer) {
    return principal.id === redeemer.user;
  }
  return (principal.memberships ?? []).some((membership) =>
    holdsScope(membership, redeemer.scope, redeemer.id, now),
  );
}

/**
 * The subject a verified capability acts as: a `link` principal holding `roles`
 * on `on` and nothing else, with `delegation.scopes` narrowing it to
 * `permissions` when the capability lists them. A `key` holder resolves to the
 * anonymous subject until user-bound credentials ship.
 */
export function capabilitySubject(
  capability: Capability,
  options: { readonly issuer?: string } = {},
): Subject<CapabilityPrincipal> {
  if (capability.holder !== "link") {
    return anonymousSubject();
  }
  const membership: Membership = {
    on: capability.on,
    roles: capability.roles,
    via: "link",
    expiresAt: capability.expiresAt,
  };
  const principal: CapabilityPrincipal = compact<CapabilityPrincipal>({
    id: capability.id,
    kind: "link",
    issuer: options.issuer,
    memberships: [membership],
    capability,
  });
  return freezeDeep(
    compact<Subject<CapabilityPrincipal>>({
      principal,
      delegation:
        capability.permissions === undefined
          ? undefined
          : {
              scopes: capability.permissions.map((key) =>
                key.replaceAll(".", ":"),
              ),
            },
      context: {},
      expiresAt: capability.expiresAt,
    }),
  );
}
