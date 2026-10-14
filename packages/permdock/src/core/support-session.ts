import type { Denial } from "./decision.ts";
import type { SettingsSource } from "./interfaces.ts";
import type { PermDock } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { Instant } from "./time.ts";

import { canonicalJson } from "./canonical-json.ts";
import { compact } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { idList, isId } from "./ids.ts";
import { ownRecord } from "./paths.ts";
import { annotationsFor } from "./permission-leaf.ts";
import { findPermission, listPermissions } from "./permission-registry.ts";
import { sha256Digest } from "./sha256.ts";
import { isRfc3339, nowSeconds, rfc3339, secondsOf } from "./time.ts";

/**
 * SupportSession v1: a support staff member (`actor`, kind `support`)
 * viewing the app as `principal` in `tenant`, for a stated `reason`. Each
 * request in the session acts as `principal` with their live rights,
 * narrowed to `permissions`.
 */
export type SupportSession = {
  readonly v: 1;
  readonly id: string;
  /** The person the session views the app as. */
  readonly principal: string;
  /** The support staff member running the session. */
  readonly actor: string;
  readonly tenant: string;
  readonly reason: string;
  /** The delegation: permission keys, read-only unless listed on purpose. */
  readonly permissions: readonly string[];
  /** RFC 3339. */
  readonly startedAt: string;
  /** RFC 3339. */
  readonly expiresAt: string;
  /** Who approved the session; never `actor`. */
  readonly approvedBy?: string;
  /** The application's ticket or case id. */
  readonly reference?: string;
};

/** A tenant's rules for support sessions. Every field only tightens. */
export type SupportSessionPolicy = {
  /** No session may start in this tenant. */
  readonly disabled?: boolean;
  /** Longest a session may last, in seconds. */
  readonly maxTtl?: number;
  /** Only `readOnlyHint` permissions, whatever the request lists. */
  readonly readOnly?: boolean;
};

export type SupportSessionRequest = {
  readonly id: string;
  /** The person to view the app as. */
  readonly principal: string;
  /** Defaults to the actor's active tenant. */
  readonly tenant?: string;
  /** Required: why the session is needed. */
  readonly reason: string;
  /** Defaults to every `readOnlyHint` permission the actor can use. */
  readonly permissions?: readonly Permission[];
  /** Seconds the session lasts. Defaults to 3600; at most 86400. */
  readonly expiresIn?: number;
  readonly reference?: string;
};

export type SupportSessionDecision =
  | { readonly outcome: "granted"; readonly session: SupportSession }
  | {
      readonly outcome: "approval-required";
      readonly session: SupportSession;
      /** Bound to the request and the actor; pass it as `approved` to resume. */
      readonly token: string;
    }
  | { readonly outcome: "denied"; readonly denials: readonly Denial[] };

export type DecideSupportSessionOptions = {
  /** Where the tenant's `supportSessions` policy comes from. */
  readonly settings?: SettingsSource;
  /** Approval is required unless this is `false`. */
  readonly approval?: boolean;
  /** The `token` of an approval the application consumed for this request. */
  readonly approved?: string;
  /** The principal id that approved; required with `approved` and never the actor. */
  readonly approvedBy?: string;
  /** The start time; defaults to the clock. */
  readonly now?: Instant;
};

const DEFAULT_TTL = 3600;
const MAX_TTL = 86_400;
const MAX_REASON = 1000;

function isReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_REASON
  );
}

/**
 * Validates an untrusted support-session record and returns a frozen copy
 * with only the v1 fields, or `undefined`.
 */
export function parseSupportSession(
  input: unknown,
): SupportSession | undefined {
  const value = ownRecord(input);
  if (
    value === undefined ||
    value["v"] !== 1 ||
    !isId(value["id"]) ||
    !isId(value["principal"]) ||
    !isId(value["actor"]) ||
    value["principal"] === value["actor"] ||
    !isId(value["tenant"]) ||
    !isReason(value["reason"]) ||
    !isRfc3339(value["startedAt"]) ||
    !isRfc3339(value["expiresAt"])
  ) {
    return undefined;
  }
  const permissions = idList(value["permissions"]);
  const { approvedBy, reference } = value;
  if (
    permissions === undefined ||
    (secondsOf(value["expiresAt"]) ?? 0) <=
      (secondsOf(value["startedAt"]) ?? 0) ||
    (approvedBy !== undefined &&
      (!isId(approvedBy) || approvedBy === value["actor"])) ||
    (reference !== undefined && !isId(reference))
  ) {
    return undefined;
  }
  return freezeDeep(
    compact<SupportSession>({
      v: 1,
      id: value["id"],
      principal: value["principal"],
      actor: value["actor"],
      tenant: value["tenant"],
      reason: value["reason"],
      permissions,
      startedAt: value["startedAt"],
      expiresAt: value["expiresAt"],
      approvedBy,
      reference,
    }),
  );
}

function denied(
  reason: Denial["reason"],
  detail?: unknown,
): SupportSessionDecision {
  return freezeDeep({
    outcome: "denied" as const,
    denials: [compact<Denial>({ role: null, reason, detail })],
  });
}

function sessionToken(
  request: SupportSessionRequest,
  actor: string,
  tenant: string,
  permissions: readonly string[],
  ttl: number,
): string {
  return sha256Digest(
    canonicalJson({
      t: "support-session",
      id: request.id,
      principal: request.principal,
      actor,
      tenant,
      reason: request.reason,
      permissions,
      ttl,
      reference: request.reference ?? null,
    }),
  );
}

/**
 * Decides whether the subject of `permdock` may start the support session
 * in `request`. The actor must be a signed-in person acting for themselves
 * (`exceeds-creator` otherwise), give a `reason` (`reason-required`), be a
 * member of the tenant (`tenant-mismatch`) and be able to use every
 * permission (`exceeds-creator`). Without `permissions` the session gets the
 * actor's read-only permissions. The tenant's `supportSessions` policy then
 * applies, and the result is `approval-required` until `approved` carries
 * its token and `approvedBy` names someone other than the actor.
 */
export async function decideSupportSession(
  permdock: PermDock,
  request: SupportSessionRequest,
  options: DecideSupportSessionOptions = {},
): Promise<SupportSessionDecision> {
  const actor = permdock.subject.principal;
  if (actor === null) {
    return denied("anonymous");
  }
  if (actor.kind !== undefined && actor.kind !== "user") {
    return denied("exceeds-creator", { creator: actor.kind });
  }
  if ("credential" in actor || "runTicket" in actor) {
    return denied("exceeds-creator", {
      creator: "credential" in actor ? "credential" : "run",
    });
  }
  if (permdock.subject.actor !== undefined) {
    return denied("exceeds-creator", { creator: "actor" });
  }
  if (!isReason(request.reason)) {
    return denied("reason-required");
  }
  const ttl = request.expiresIn ?? DEFAULT_TTL;
  if (
    !isId(request.id) ||
    !isId(request.principal) ||
    request.principal === actor.id ||
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    ttl > MAX_TTL ||
    (request.reference !== undefined && !isId(request.reference))
  ) {
    return denied("validation");
  }
  const tenant = request.tenant ?? actor.tenant;
  if (tenant === undefined) {
    return denied("validation");
  }
  if (!permdock.tenants().includes(tenant)) {
    return denied("tenant-mismatch", { tenant });
  }
  let policy: SupportSessionPolicy | undefined;
  if (options.settings !== undefined) {
    try {
      policy = (await options.settings.settingsFor(tenant))?.supportSessions;
    } catch {
      return denied("unsupported", { rule: "unavailable" });
    }
  }
  if (policy?.disabled === true) {
    return denied("unsupported", { rule: "disabled" });
  }
  if (policy?.maxTtl !== undefined && ttl > policy.maxTtl) {
    return denied("validation", { rule: "ttl" });
  }
  const leaves =
    request.permissions === undefined
      ? listPermissions(permdock.permissions).filter(
          (leaf) => annotationsFor(leaf).readOnlyHint && permdock.mayUse(leaf),
        )
      : request.permissions.map((permission) =>
          findPermission(permdock.permissions, permission.key),
        );
  const keys: string[] = [];
  for (const leaf of leaves) {
    if (leaf === undefined) {
      return denied("validation");
    }
    if (!permdock.mayUse(leaf)) {
      return denied("exceeds-creator", { permission: leaf.key });
    }
    if (policy?.readOnly === true && !annotationsFor(leaf).readOnlyHint) {
      return denied("not-delegated", {
        permission: leaf.key,
        rule: "read-only",
      });
    }
    if (!keys.includes(leaf.key)) {
      keys.push(leaf.key);
    }
  }
  if (keys.length === 0) {
    return denied("no-grant");
  }
  const token = sessionToken(request, actor.id, tenant, keys, ttl);
  const approval = options.approval !== false;
  const approved = approval && options.approved === token;
  if (
    approved &&
    (options.approvedBy === undefined || options.approvedBy === actor.id)
  ) {
    return denied("approval", "approver-not-distinct");
  }
  const startedAt = nowSeconds(options.now);
  const session = parseSupportSession(
    compact({
      v: 1,
      id: request.id,
      principal: request.principal,
      actor: actor.id,
      tenant,
      reason: request.reason,
      permissions: keys,
      startedAt: rfc3339(startedAt),
      expiresAt: rfc3339(startedAt + ttl),
      approvedBy: approved ? options.approvedBy : undefined,
      reference: request.reference,
    }),
  );
  if (session === undefined) {
    return denied("validation");
  }
  if (approval && !approved) {
    return freezeDeep({
      outcome: "approval-required" as const,
      session,
      token,
    });
  }
  return freezeDeep({ outcome: "granted" as const, session });
}
