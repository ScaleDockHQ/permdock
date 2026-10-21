import type { AuthEvent } from "../core/event-types.ts";
import type { Permission, PermissionTree } from "../core/permission-types.ts";

import {
  type Capability,
  type CapabilityPrincipal,
  type LinkPolicy,
  capabilityOf,
  capabilitySubject,
  linkPolicyViolation,
} from "../core/capability.ts";
import { compact } from "../core/compact.ts";
import { idList, isId } from "../core/ids.ts";
import { type Subject, anonymousSubject } from "../core/subject.ts";
import { type Instant, nowSeconds } from "../core/time.ts";

/**
 * The fields of better-supabase's `ResolvedShareLink` a link subject is built
 * from.
 */
export type ShareLinkRow = {
  readonly id: string;
  readonly organizationId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly role: string;
  /** Set on a link pinned to one version, which `subjectFromShareLink` refuses. */
  readonly versionId?: string;
  readonly expiresAt?: Instant;
};

/** better-supabase's `ShareLinks`, or anything with its `resolve`. */
export type ShareLinkResolver = {
  resolve(
    token: string,
  ): PromiseLike<
    | { readonly ok: true; readonly data: ShareLinkRow | null }
    | { readonly ok: false }
  >;
};

/** How links on one better-supabase subject type map to PermDock. */
export type ShareLinkTarget = {
  /**
   * The resource the subject type's rows are; RLS matches it against
   * `capability.on.resource`.
   */
  readonly resource: Permission | PermissionTree;
  /**
   * PermDock roles for each share-link role (`{ view: ['guest'] }`). A role
   * with no entry is refused.
   */
  readonly roles: Readonly<Record<string, readonly string[]>>;
};

export type ShareLinkSubjectOptions = {
  readonly shareLinks: ShareLinkResolver;
  /**
   * One entry per subject type a guest page serves, keyed by better-supabase's
   * `subjectType`.
   */
  readonly links: Readonly<Record<string, ShareLinkTarget>>;
  /**
   * Lifetime of the subject in seconds, capped by the link's own expiry.
   * Default 300, at most 3600.
   */
  readonly ttl?: number;
  /**
   * The link policies of the link's organization (`row.organizationId`); every
   * one must hold, and a throw denies. A row carries no creation time, so a
   * `maxLifetime` rule refuses every share link.
   */
  readonly linkPolicy?: (
    capability: Capability,
    row: ShareLinkRow,
  ) =>
    | LinkPolicy
    | readonly LinkPolicy[]
    | undefined
    | Promise<LinkPolicy | readonly LinkPolicy[] | undefined>;
  readonly onAuth?: (event: AuthEvent) => void;
  readonly requestId?: string;
  readonly now?: Instant;
};

const DEFAULT_TTL = 300;
const MAX_TTL = 3600;

function ownEntry<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isRow(value: unknown): value is ShareLinkRow {
  if (typeof value !== "object" || value === null) return false;
  const row: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(value),
  );
  const expiresAt = row["expiresAt"];
  return (
    isId(row["id"]) &&
    isId(row["organizationId"]) &&
    isId(row["subjectType"]) &&
    isId(row["subjectId"]) &&
    typeof row["role"] === "string" &&
    (row["versionId"] === undefined || typeof row["versionId"] === "string") &&
    (expiresAt === undefined ||
      (typeof expiresAt === "object" &&
        expiresAt !== null &&
        "epochMilliseconds" in expiresAt &&
        typeof expiresAt.epochMilliseconds === "number" &&
        Number.isFinite(expiresAt.epochMilliseconds)))
  );
}

/**
 * Resolves a better-supabase share-link token into the `link` subject it acts
 * as, for `exchangeCapability` and `--capabilities` RLS. The row is read on
 * every call, so a revoked or expired link stops resolving at once. An unknown
 * token, subject type or role, a malformed row, a broken link policy, a
 * `resolve` error and a throw are the anonymous subject. So is a link pinned to
 * a version: a capability grants the subject's current rows, so a pinned link
 * reads through `versions.getShared(token)` instead.
 */
export async function subjectFromShareLink(
  token: string | undefined | null,
  options: ShareLinkSubjectOptions,
): Promise<Subject<CapabilityPrincipal>> {
  if (token === undefined || token === null || token.length === 0) {
    return anonymousSubject();
  }
  const deny = (
    reason: AuthEvent["reason"],
    cause?: string,
  ): Subject<CapabilityPrincipal> => {
    options.onAuth?.(
      compact<AuthEvent>({
        reason,
        cause,
        source: "share-link",
        requestId: options.requestId,
      }),
    );
    return anonymousSubject();
  };
  let row: ShareLinkRow;
  try {
    const resolved = await options.shareLinks.resolve(token);
    if (!resolved.ok) {
      return deny("source-threw", "resolve-failed");
    }
    if (resolved.data === null) {
      return deny("invalid-token", "share-link-unknown");
    }
    if (!isRow(resolved.data)) {
      return deny("schema", "share-link-malformed");
    }
    row = resolved.data;
  } catch {
    return deny("source-threw");
  }
  if (row.versionId !== undefined) {
    return deny("invalid-token", "share-link-pinned");
  }
  const target = ownEntry(options.links, row.subjectType);
  if (target === undefined) {
    return deny("invalid-token", "subject-type-unknown");
  }
  const roles = idList(ownEntry(target.roles, row.role));
  if (roles === undefined || roles.length === 0) {
    return deny("unknown-role");
  }
  const now = nowSeconds(options.now);
  const ttl = Math.min(Math.max(1, options.ttl ?? DEFAULT_TTL), MAX_TTL);
  const rowExpiry =
    row.expiresAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.floor(row.expiresAt.epochMilliseconds / 1000);
  const expiresAt = Math.min(now + ttl, rowExpiry);
  if (expiresAt <= now) {
    return deny("invalid-token", "expired");
  }
  let capability: Capability;
  try {
    capability = capabilityOf({
      id: row.id,
      on: { resource: target.resource, id: row.subjectId },
      roles,
      expiresAt,
    });
  } catch {
    return deny("schema", "invalid-claims");
  }
  try {
    const policy = await options.linkPolicy?.(capability, row);
    if (
      policy !== undefined &&
      linkPolicyViolation(capability, policy, undefined) !== undefined
    ) {
      return deny("invalid-token", "link-policy");
    }
  } catch {
    return deny("source-threw");
  }
  return capabilitySubject(capability);
}
