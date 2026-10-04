import type { Denial } from "./decision.ts";
import type { SettingsSource } from "./interfaces.ts";
import type { PermDock } from "./permdock.ts";
import type { Permission, PermissionTree } from "./permissions.ts";
import type {
  AuthorizationDetail,
  Delegation,
  Membership,
  Principal,
  Subject,
} from "./subject.ts";

import { idList, isId, ownRecord } from "./capability.ts";
import { compact, isReadonlyArray } from "./compact.ts";
import { coveredByDelegation } from "./delegation.ts";
import { freezeDeep } from "./freeze.ts";
import { formerKeys, listPermissions } from "./permissions.ts";
import { bytesToBase64Url, sha256 } from "./sha256.ts";
import { anonymousSubject } from "./subject.ts";

export type CredentialKind = "user" | "service";

/** One permission (a key) a credential may use: on every instance, or only on `ids`. */
export type CredentialPermission = {
  readonly permission: string;
  readonly ids?: readonly string[];
};

/**
 * Credential v1: what a verified API key stands for, never the secret. A
 * `user` credential acts as its owner (`principal`) narrowed to
 * `permissions`; a `service` credential is its own `service` principal
 * holding `roles` in `tenant`, narrowed the same way.
 */
export type Credential = {
  readonly v: 1;
  readonly id: string;
  readonly kind: CredentialKind;
  /** The owner of a `user` credential, or the id of the service principal. */
  readonly principal: string;
  /** Service only: the instance of the first scope its roles are held in. */
  readonly tenant?: string;
  /** Service only: the roles it holds in `tenant`. */
  readonly roles?: readonly string[];
  readonly permissions: readonly CredentialPermission[];
  readonly createdBy: string;
  /** Seconds since the epoch. */
  readonly createdAt: number;
  /** Seconds since the epoch; absent only where a credential policy allows it. */
  readonly expiresAt?: number;
  readonly name?: string;
};

export type CredentialPrincipal = Principal & {
  readonly credential: Credential;
};

/**
 * What one scope instance allows for API keys created in it. Every rule only
 * tightens; several policies must all hold.
 */
export type CredentialPolicy = {
  /** Longest a key may live, in seconds from `createdAt`. */
  readonly maxTtl?: number;
  /** Kinds that may be created. */
  readonly kinds?: readonly CredentialKind[];
  /** Creating a key is `approval-required`. */
  readonly approval?: boolean;
  /** A key may omit `expiresAt`; without it every key must expire. */
  readonly allowNoExpiry?: boolean;
};

export type CredentialPolicyViolation = "kind" | "no-expiry" | "ttl";

export type CredentialPermissionInput =
  | Permission
  | { readonly permission: Permission; readonly ids: readonly string[] };

type CredentialRequestBase = {
  readonly id: string;
  readonly permissions: readonly CredentialPermissionInput[];
  readonly expiresAt?: number;
  readonly name?: string;
};

export type CredentialRequest =
  | (CredentialRequestBase & { readonly kind: "user" })
  | (CredentialRequestBase & {
      readonly kind: "service";
      /** The service principal's id; defaults to the credential id. */
      readonly principal?: string;
      readonly tenant: string;
      readonly roles: readonly string[];
    });

export type CredentialDecision =
  | { readonly outcome: "granted"; readonly credential: Credential }
  | {
      readonly outcome: "approval-required";
      readonly credential: Credential;
      /** Bound to the credential's content and its creator; pass it as `approved` to resume. */
      readonly token: string;
    }
  | { readonly outcome: "denied"; readonly denials: readonly Denial[] };

export type DecideCredentialOptions = {
  /** Where the tenant's `credentials` policy comes from. Without it, only the no-expiry rule applies. */
  readonly settings?: SettingsSource;
  /** The `token` of an approval the application consumed for this request. */
  readonly approved?: string;
  /** Seconds since the epoch. */
  readonly now?: number;
};

const MAX_ENTRIES = 64;
const MAX_NAME = 256;

function policies(
  policy: CredentialPolicy | readonly CredentialPolicy[],
): readonly CredentialPolicy[] {
  return isReadonlyArray(policy) ? policy : [policy];
}

/**
 * The first rule of `policy` the credential breaks, or `undefined`. A key
 * without `expiresAt` passes only when some policy sets `allowNoExpiry` and
 * none sets `maxTtl`; an empty list therefore refuses it.
 */
export function credentialPolicyViolation(
  credential: Credential,
  policy: CredentialPolicy | readonly CredentialPolicy[],
): CredentialPolicyViolation | undefined {
  const list = policies(policy);
  for (const item of list) {
    if (item.kinds !== undefined && !item.kinds.includes(credential.kind)) {
      return "kind";
    }
  }
  if (credential.expiresAt === undefined) {
    const allowed =
      list.some((item) => item.allowNoExpiry === true) &&
      list.every((item) => item.maxTtl === undefined);
    return allowed ? undefined : "no-expiry";
  }
  for (const item of list) {
    const max = item.maxTtl;
    if (
      max !== undefined &&
      (typeof max !== "number" ||
        !Number.isFinite(max) ||
        max < 0 ||
        credential.expiresAt - credential.createdAt > max)
    ) {
      return "ttl";
    }
  }
  return undefined;
}

function parsePermissions(
  value: unknown,
): readonly CredentialPermission[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ENTRIES
  ) {
    return undefined;
  }
  const out: CredentialPermission[] = [];
  for (const item of value) {
    const entry = ownRecord(item);
    if (entry === undefined || !isId(entry["permission"])) {
      return undefined;
    }
    const ids = entry["ids"] === undefined ? undefined : idList(entry["ids"]);
    if (entry["ids"] !== undefined && ids === undefined) {
      return undefined;
    }
    out.push(
      compact<CredentialPermission>({ permission: entry["permission"], ids }),
    );
  }
  return out;
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates an untrusted credential record and returns a frozen copy with
 * only the v1 fields, or `undefined`. Unknown fields are dropped; a wrong
 * type in a known field, a service credential without `tenant` and `roles`,
 * or a user credential with either, rejects the whole record.
 */
export function parseCredential(input: unknown): Credential | undefined {
  const value = ownRecord(input);
  if (value === undefined || value["v"] !== 1 || !isId(value["id"])) {
    return undefined;
  }
  if (value["kind"] !== "user" && value["kind"] !== "service") {
    return undefined;
  }
  if (!isId(value["principal"]) || !isId(value["createdBy"])) {
    return undefined;
  }
  const permissions = parsePermissions(value["permissions"]);
  if (permissions === undefined || !isTime(value["createdAt"])) {
    return undefined;
  }
  if (value["expiresAt"] !== undefined && !isTime(value["expiresAt"])) {
    return undefined;
  }
  if (
    value["name"] !== undefined &&
    (typeof value["name"] !== "string" || value["name"].length > MAX_NAME)
  ) {
    return undefined;
  }
  let tenant: string | undefined;
  let roles: readonly string[] | undefined;
  if (value["kind"] === "service") {
    roles = idList(value["roles"]);
    if (!isId(value["tenant"]) || roles === undefined) {
      return undefined;
    }
    tenant = value["tenant"];
  } else if (value["tenant"] !== undefined || value["roles"] !== undefined) {
    return undefined;
  }
  return freezeDeep(
    compact<Credential>({
      v: 1,
      id: value["id"],
      kind: value["kind"],
      principal: value["principal"],
      tenant,
      roles,
      permissions,
      createdBy: value["createdBy"],
      createdAt: value["createdAt"],
      expiresAt: value["expiresAt"],
      name: value["name"],
    }),
  );
}

function leafByKey(tree: PermissionTree): ReadonlyMap<string, Permission> {
  const byKey = new Map<string, Permission>();
  for (const leaf of listPermissions(tree)) {
    byKey.set(leaf.key, leaf);
    for (const old of formerKeys(leaf)) {
      byKey.set(old, leaf);
    }
  }
  return byKey;
}

/**
 * The delegation a credential narrows its principal to: OAuth scopes for
 * permissions on every instance, one RFC 9396 entry per id otherwise. A key
 * the definitions no longer declare is dropped, so a credential whose every
 * key is gone delegates nothing and every check is denied.
 */
export function credentialDelegation(
  credential: Credential,
  permissions: PermissionTree,
): Delegation {
  const leaves = leafByKey(permissions);
  const scopes: string[] = [];
  const details: AuthorizationDetail[] = [];
  for (const entry of credential.permissions) {
    const leaf = leaves.get(entry.permission);
    if (leaf === undefined) {
      continue;
    }
    if (entry.ids === undefined) {
      scopes.push(leaf.scope);
      continue;
    }
    for (const id of entry.ids) {
      details.push({
        type: leaf.resource,
        actions: [leaf.action],
        identifier: id,
      });
    }
  }
  return compact<Delegation>({
    scopes: scopes.length > 0 || details.length === 0 ? scopes : undefined,
    authorizationDetails: details.length > 0 ? details : undefined,
  });
}

/**
 * The subject a verified credential acts as. A `user` credential is its
 * owner, passed live as `owner` (roles and memberships as of this request),
 * with the credential's delegation: every check is the owner's rights
 * intersected with the key's. A `service` credential is a `service`
 * principal whose only membership is `roles` in `tenant`. An owner whose id
 * is not the credential's `principal`, or who is not a user, is anonymous.
 */
export function credentialSubject(
  credential: Credential,
  options: {
    readonly permissions: PermissionTree;
    readonly owner?: Principal;
  },
): Subject<CredentialPrincipal> | Subject {
  const delegation = credentialDelegation(credential, options.permissions);
  let principal: CredentialPrincipal;
  if (credential.kind === "user") {
    const owner = options.owner ?? { id: credential.principal, kind: "user" };
    if (
      owner.id !== credential.principal ||
      (owner.kind !== undefined && owner.kind !== "user")
    ) {
      return anonymousSubject();
    }
    principal = { ...owner, kind: "user", credential };
  } else {
    const membership = compact<Membership>({
      tenant: credential.tenant,
      roles: credential.roles ?? [],
      via: "credential",
    });
    principal = compact<CredentialPrincipal>({
      id: credential.principal,
      kind: "service",
      tenant: credential.tenant,
      memberships: [membership],
      credential,
    });
  }
  return freezeDeep(
    compact<Subject<CredentialPrincipal>>({
      principal,
      delegation,
      context: {},
      expiresAt: credential.expiresAt,
    }),
  );
}

function credentialToken(credential: Credential): string {
  const payload = JSON.stringify({
    t: "credential",
    id: credential.id,
    kind: credential.kind,
    principal: credential.principal,
    tenant: credential.tenant ?? null,
    roles: credential.roles ?? null,
    permissions: credential.permissions,
    createdBy: credential.createdBy,
    expiresAt: credential.expiresAt ?? null,
    name: credential.name ?? null,
  });
  return `pd1.${bytesToBase64Url(sha256(payload))}`;
}

function denied(
  reason: Denial["reason"],
  detail?: unknown,
): CredentialDecision {
  return freezeDeep({
    outcome: "denied" as const,
    denials: [compact<Denial>({ role: null, reason, detail })],
  });
}

function permissionEntries(
  request: CredentialRequest,
  declared: ReadonlyMap<string, Permission>,
):
  | readonly {
      readonly leaf: Permission;
      readonly ids?: readonly string[];
    }[]
  | undefined {
  if (
    !isReadonlyArray(request.permissions) ||
    request.permissions.length === 0 ||
    request.permissions.length > MAX_ENTRIES
  ) {
    return undefined;
  }
  const out: { readonly leaf: Permission; readonly ids?: readonly string[] }[] =
    [];
  for (const item of request.permissions) {
    const entry = permissionEntry(item);
    if (entry === undefined || declared.get(entry.leaf.key) === undefined) {
      return undefined;
    }
    out.push(entry);
  }
  return out;
}

function permissionEntry(
  item: CredentialPermissionInput,
): { readonly leaf: Permission; readonly ids?: readonly string[] } | undefined {
  if (!isScopedInput(item)) {
    return { leaf: item };
  }
  const ids = idList(item.ids);
  return ids === undefined ? undefined : { leaf: item.permission, ids };
}

function isScopedInput(
  item: CredentialPermissionInput,
): item is Extract<CredentialPermissionInput, { readonly ids: unknown }> {
  return "permission" in item && "ids" in item;
}

type Checked =
  | { readonly ok: true; readonly credential: Credential }
  | { readonly ok: false; readonly decision: CredentialDecision };

function refuse(reason: Denial["reason"], detail?: unknown): Checked {
  return { ok: false, decision: denied(reason, detail) };
}

function checkRequest(
  permdock: PermDock,
  request: CredentialRequest,
  now: number,
): Checked {
  const creator = permdock.subject.principal;
  if (creator === null) {
    return refuse("anonymous");
  }
  if (creator.kind === "link" || "credential" in creator) {
    return refuse("exceeds-creator", {
      creator: creator.kind === "link" ? "link" : "credential",
    });
  }
  const entries = permissionEntries(request, leafByKey(permdock.permissions));
  if (
    entries === undefined ||
    !isId(request.id) ||
    (request.expiresAt !== undefined &&
      (!isTime(request.expiresAt) || request.expiresAt <= now))
  ) {
    return refuse("validation");
  }
  const subject = permdock.subject;
  for (const entry of entries) {
    for (const id of entry.ids ?? [undefined]) {
      if (
        coveredByDelegation(
          entry.leaf,
          subject.delegation,
          id,
          subject.actor !== undefined,
        ) !== undefined
      ) {
        return refuse("exceeds-creator", { permission: entry.leaf.key });
      }
    }
  }
  const credential = parseCredential(
    compact({
      v: 1,
      id: request.id,
      kind: request.kind,
      principal:
        request.kind === "service"
          ? (request.principal ?? request.id)
          : creator.id,
      tenant: request.kind === "service" ? request.tenant : undefined,
      roles: request.kind === "service" ? request.roles : undefined,
      permissions: entries.map((entry) =>
        compact({ permission: entry.leaf.key, ids: entry.ids }),
      ),
      createdBy: creator.id,
      createdAt: now,
      expiresAt:
        request.expiresAt === undefined
          ? undefined
          : Math.floor(request.expiresAt),
      name: request.name,
    }),
  );
  if (credential === undefined) {
    return refuse("validation");
  }
  if (credential.tenant !== undefined) {
    const tenant = credential.tenant;
    if (!permdock.tenants().includes(tenant)) {
      return refuse("exceeds-creator", { tenant });
    }
    const roles = new Set(
      permdock.assignableRoles({ tenant }).map((role) => role.key),
    );
    for (const name of credential.roles ?? []) {
      if (!roles.has(name)) {
        return refuse("exceeds-creator", { role: name });
      }
    }
    const ceiling = new Set(
      permdock.assignablePermissions({ tenant }).map((leaf) => leaf.key),
    );
    for (const entry of credential.permissions) {
      if (!ceiling.has(entry.permission)) {
        return refuse("exceeds-creator", { permission: entry.permission });
      }
    }
  }
  return { ok: true, credential };
}

/**
 * The tenant whose `credentials` policy governs a credential: a service
 * key's own tenant, otherwise `active` (the creator's or the request's).
 */
export function credentialTenant(
  credential: Credential,
  active: string | undefined,
): string | undefined {
  return credential.tenant ?? active;
}

/**
 * Decides whether the subject of `permdock` may create the credential in
 * `request`. The creator must be a signed-in user or service that is not
 * itself a link or a credential; a delegated creator hands out only what its
 * delegation covers. A service key's tenant must be one the creator is a
 * member of, its roles among the creator's `assignableRoles` there and its
 * permissions within `assignablePermissions` there (`exceeds-creator`). The
 * `credentials` policy of the key's tenant (a service key's own, a user
 * key's the creator's active tenant) then applies (`credential-policy`; a
 * settings source that throws denies with `rule: 'unavailable'`), and
 * `approval` makes the result `approval-required` until `approved` carries
 * its token. PermDock never stores the credential; the application does,
 * after a `granted` result.
 */
export async function decideCredential(
  permdock: PermDock,
  request: CredentialRequest,
  options: DecideCredentialOptions = {},
): Promise<CredentialDecision> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const checked = checkRequest(permdock, request, now);
  if (!checked.ok) {
    return checked.decision;
  }
  const { credential } = checked;
  const tenant = credentialTenant(
    credential,
    permdock.subject.principal?.tenant,
  );
  let policy: CredentialPolicy | undefined;
  if (options.settings !== undefined && tenant !== undefined) {
    try {
      policy = (await options.settings.settingsFor(tenant))?.credentials;
    } catch {
      return denied("credential-policy", { rule: "unavailable" });
    }
  }
  const list = policy === undefined ? [] : [policy];
  const violation = credentialPolicyViolation(credential, list);
  if (violation !== undefined) {
    return denied("credential-policy", { rule: violation });
  }
  if (list.some((item) => item.approval === true)) {
    const token = credentialToken(credential);
    if (options.approved !== token) {
      return freezeDeep({
        outcome: "approval-required" as const,
        credential,
        token,
      });
    }
  }
  return freezeDeep({ outcome: "granted" as const, credential });
}
