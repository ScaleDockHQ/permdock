import type { Principal } from "./subject.ts";

import { ownRecord } from "./capability.ts";
import { freezeCopy } from "./freeze.ts";

/**
 * An identity the application has linked to one of its principals: an email
 * address or a chat platform user.
 */
export type PrincipalIdentity = {
  readonly kind: "email" | "chat";
  /** The chat platform (`slack`, `teams`, …); absent for email. */
  readonly provider?: string;
  /** The address (RFC 5322 `addr-spec`) or the platform user id. Emails compare trimmed and case-insensitively. */
  readonly value: string;
  /** The chat workspace or team id. */
  readonly workspace?: string;
};

/**
 * Live principals by id, a subject input like `MembershipSource`. `null`, a
 * throw or a rejection is no principal, and so is a missing
 * `principalByIdentity`: every reader fails closed.
 */
export type PrincipalSource<TPrincipal extends Principal = Principal> = {
  /** The principal as of this request, or `null` for one deleted, suspended or unknown. */
  principal(
    id: string,
    options?: { readonly tenant?: string },
  ): TPrincipal | null | Promise<TPrincipal | null>;
  /** The principal an app-owned identity link points to, or `null` when none does. */
  principalByIdentity?(
    identity: PrincipalIdentity,
  ): TPrincipal | null | Promise<TPrincipal | null>;
};

/** One `memoryPrincipalSource` identity link: `identity` resolves to the principal with id `principal`. */
export type PrincipalIdentityLink = {
  readonly identity: PrincipalIdentity;
  readonly principal: string;
};

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * A `PrincipalIdentity` in the form sources compare: an email trimmed and
 * lower-cased with no provider or workspace, a chat identity with a
 * provider. Anything else, inherited fields included, is `undefined`.
 */
export function normalizeIdentity(
  value: unknown,
): PrincipalIdentity | undefined {
  const record = ownRecord(value);
  const kind = record?.["kind"];
  const raw = record?.["value"];
  if (record === undefined || !nonEmpty(raw)) {
    return undefined;
  }
  if (kind === "email") {
    return Object.freeze({ kind, value: raw.trim().toLowerCase() });
  }
  if (kind !== "chat") {
    return undefined;
  }
  const provider = record["provider"];
  const workspace = record["workspace"];
  if (
    !nonEmpty(provider) ||
    (workspace !== undefined && !nonEmpty(workspace))
  ) {
    return undefined;
  }
  return Object.freeze({
    kind,
    provider,
    value: raw,
    ...(workspace === undefined ? {} : { workspace }),
  });
}

function identityKey(identity: PrincipalIdentity): string {
  return JSON.stringify([
    identity.kind,
    identity.provider ?? null,
    identity.workspace ?? null,
    identity.value,
  ]);
}

function principalWithId<TPrincipal extends Principal>(
  found: unknown,
  id?: string,
): TPrincipal | null {
  const foundId = ownRecord(found)?.["id"];
  if (!nonEmpty(foundId) || (id !== undefined && foundId !== id)) {
    return null;
  }
  // SAFETY: a non-null object with its own non-empty string id, the one field every reader relies on.
  return found as TPrincipal;
}

/**
 * `source.principal(id, { tenant })`, failing closed: no source, `null`, a
 * throw, a rejection or a principal with another id is `null`.
 */
export async function loadPrincipal<TPrincipal extends Principal>(
  source: PrincipalSource<TPrincipal> | undefined,
  id: string,
  tenant?: string,
): Promise<TPrincipal | null> {
  if (source === undefined || !nonEmpty(id)) {
    return null;
  }
  try {
    const found: unknown = await source.principal(
      id,
      tenant === undefined ? {} : { tenant },
    );
    return principalWithId<TPrincipal>(found, id);
  } catch {
    return null;
  }
}

/**
 * `source.principalByIdentity(identity)` over the normalised identity,
 * failing closed: no source or method, an invalid identity, `null`, a throw
 * or a rejection is `null`.
 */
export async function loadPrincipalByIdentity<TPrincipal extends Principal>(
  source: PrincipalSource<TPrincipal> | undefined,
  identity: PrincipalIdentity,
): Promise<TPrincipal | null> {
  const normalized = normalizeIdentity(identity);
  if (
    source === undefined ||
    source.principalByIdentity === undefined ||
    normalized === undefined
  ) {
    return null;
  }
  try {
    const found: unknown = await source.principalByIdentity(normalized);
    return principalWithId<TPrincipal>(found);
  } catch {
    return null;
  }
}

/**
 * In-process principals for tests and single-replica apps. `identities`
 * links an email or chat identity to a principal id; each answer is a fresh
 * frozen copy. `tenant` is not a filter, as for a database source.
 */
export function memoryPrincipalSource<TPrincipal extends Principal>(input: {
  readonly principals: readonly TPrincipal[];
  readonly identities?: readonly PrincipalIdentityLink[];
}): PrincipalSource<TPrincipal> & {
  principalByIdentity(identity: PrincipalIdentity): TPrincipal | null;
} {
  const byId = new Map<string, TPrincipal>();
  for (const principal of input.principals) {
    if (!nonEmpty(principal.id) || byId.has(principal.id)) {
      throw new TypeError(
        "PermDock: memoryPrincipalSource needs a unique, non-empty id per principal",
      );
    }
    byId.set(principal.id, principal);
  }
  const links = new Map<string, string>();
  for (const link of input.identities ?? []) {
    const identity = normalizeIdentity(link.identity);
    if (identity === undefined || !nonEmpty(link.principal)) {
      throw new TypeError(
        "PermDock: memoryPrincipalSource identities link an email or chat identity to a principal id",
      );
    }
    links.set(identityKey(identity), link.principal);
  }
  const copyOf = (id: string | undefined): TPrincipal | null => {
    const found = id === undefined ? undefined : byId.get(id);
    return found === undefined ? null : freezeCopy(structuredClone(found));
  };
  return Object.freeze({
    principal(id: string): TPrincipal | null {
      return copyOf(id);
    },
    principalByIdentity(identity: PrincipalIdentity): TPrincipal | null {
      const normalized = normalizeIdentity(identity);
      return normalized === undefined
        ? null
        : copyOf(links.get(identityKey(normalized)));
    },
  });
}
