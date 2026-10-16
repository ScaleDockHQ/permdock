import type { AuthEvent } from "../core/event-types.ts";
import type {
  TokenFailureCause,
  TokenSigner,
  TokenVerifier,
} from "../core/interfaces.ts";
import type { PermissionTree } from "../core/permission-types.ts";
import type { PrincipalSource } from "../core/principal-source.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { SupportSession } from "../core/support-session.ts";

import { compact } from "../core/compact.ts";
import { ownRecord } from "../core/paths.ts";
import { annotationsFor } from "../core/permission-leaf.ts";
import { findPermission } from "../core/permission-registry.ts";
import { anonymousSubject } from "../core/subject.ts";
import { parseSupportSession } from "../core/support-session.ts";
import { epochSeconds, rfc3339, secondsOf } from "../core/time.ts";

const SUPPORT_SESSION_TYP = "vnd.permdock.support-session+jwt";

/** `on('auth')` causes: a verification failure, or one of the session checks. */
export type SupportSessionFailureCause =
  | TokenFailureCause
  | "invalid-claims"
  | "session-ended"
  | "principal-unavailable"
  | "actor-unavailable";

/** The live state of each support session, so one can end before it expires. */
export type SupportSessionSource = {
  /** The session as of now, or `null` for an unknown one. A throw ends it. */
  session(
    id: string,
  ):
    | { readonly id: string; readonly ended?: boolean }
    | null
    | Promise<{ readonly id: string; readonly ended?: boolean } | null>;
};

export type SupportSessionSubjectOptions = {
  readonly verifier: TokenVerifier;
  /** Loads the viewed principal and the support actor, live, on every request. */
  readonly principals: PrincipalSource;
  /** The permission tree the session's keys name. */
  readonly permissions: PermissionTree;
  /** Checked on every request when set; an unknown or ended session denies. */
  readonly sessions?: SupportSessionSource;
  readonly audience?: string | readonly string[];
  readonly issuer?: string;
  readonly clockTolerance?: number;
  readonly onAuth?: (event: AuthEvent) => void;
  readonly requestId?: string;
};

/** `subject.context.supportSession` of a subject resolved from a session token. */
export type SupportSessionContext = {
  readonly id: string;
  readonly reason: string;
  readonly approvedBy?: string;
  readonly reference?: string;
};

/**
 * Signs a granted `SupportSession` as a `vnd.permdock.support-session+jwt`
 * (`sub` the viewed principal, `act` the support actor, `jti` the session
 * id) that expires with the session. Throws a `TypeError` for a record
 * `parseSupportSession` refuses.
 */
export function signSupportSession(
  session: SupportSession,
  signer: TokenSigner,
  options: { readonly audience?: string | readonly string[] } = {},
): Promise<string> {
  const parsed = parseSupportSession(session);
  if (parsed === undefined) {
    throw new TypeError("PermDock: invalid support session");
  }
  return signer.sign(
    compact({
      v: 1,
      sub: parsed.principal,
      act: { sub: parsed.actor, kind: "support" },
      tenant: parsed.tenant,
      reason: parsed.reason,
      permissions: parsed.permissions,
      approved_by: parsed.approvedBy,
      reference: parsed.reference,
    }),
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: SUPPORT_SESSION_TYP,
      audience: options.audience,
      expiresAt: secondsOf(parsed.expiresAt),
      issuedAt: secondsOf(parsed.startedAt),
      jti: parsed.id,
    }),
  );
}

function sessionOf(claims: unknown): SupportSession | undefined {
  const record = ownRecord(claims);
  const act = ownRecord(record?.["act"]);
  const { iat, exp } = record ?? {};
  if (
    record === undefined ||
    act === undefined ||
    act["kind"] !== "support" ||
    act["act"] !== undefined ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp)
  ) {
    return undefined;
  }
  return parseSupportSession({
    v: record["v"],
    id: record["jti"],
    principal: record["sub"],
    actor: act["sub"],
    tenant: record["tenant"],
    reason: record["reason"],
    permissions: record["permissions"],
    startedAt: rfc3339(iat),
    expiresAt: rfc3339(exp),
    approvedBy: record["approved_by"],
    reference: record["reference"],
  });
}

async function load(
  principals: PrincipalSource,
  id: string,
  tenant: string,
): Promise<Principal | undefined> {
  try {
    const loaded: unknown = await principals.principal(id, { tenant });
    const record = ownRecord(loaded);
    if (record === undefined || record["id"] !== id) {
      return undefined;
    }
    // SAFETY: a plain object whose own `id` is the requested string id.
    return loaded as Principal;
  } catch {
    return undefined;
  }
}

async function ended(
  sessions: SupportSessionSource | undefined,
  id: string,
): Promise<boolean> {
  if (sessions === undefined) {
    return false;
  }
  try {
    const live = ownRecord(await sessions.session(id));
    return live === undefined || live["id"] !== id || live["ended"] === true;
  } catch {
    return true;
  }
}

/**
 * Resolves a `vnd.permdock.support-session+jwt` into the subject each
 * request of the session acts as: the viewed principal loaded live, a
 * `support` actor, the session's permissions as the delegation and
 * `context.supportSession`. The actor must still exist. Every failure is the
 * anonymous subject, never a throw.
 */
export async function subjectFromSupportSession(
  token: string | undefined | null,
  options: SupportSessionSubjectOptions,
): Promise<Subject> {
  if (typeof token !== "string" || token.length === 0) {
    return anonymousSubject();
  }
  const deny = (cause: SupportSessionFailureCause): Subject => {
    try {
      options.onAuth?.(
        compact<AuthEvent>({
          reason: "invalid-token",
          cause,
          source: "support-session",
          typ: SUPPORT_SESSION_TYP,
          issuer: options.issuer,
          requestId: options.requestId,
        }),
      );
    } catch {
      // a listener never changes the outcome
    }
    return anonymousSubject();
  };
  let session: ReturnType<typeof sessionOf>;
  try {
    const verified = await options.verifier.verify(
      token,
      compact({
        typ: SUPPORT_SESSION_TYP,
        audience: options.audience,
        issuer: options.issuer,
        clockTolerance: options.clockTolerance,
      }),
    );
    if (!verified.ok) {
      return deny(verified.cause);
    }
    const typ = verified.header.typ
      ?.toLowerCase()
      .replace(/^application\//u, "");
    if (typ !== SUPPORT_SESSION_TYP) {
      return deny("wrong-token-type");
    }
    session = sessionOf(verified.claims);
  } catch {
    return deny("malformed");
  }
  if (session === undefined) {
    return deny("invalid-claims");
  }
  if ((secondsOf(session.expiresAt) ?? 0) <= epochSeconds()) {
    return deny("expired");
  }
  if (await ended(options.sessions, session.id)) {
    return deny("session-ended");
  }
  const actor = await load(options.principals, session.actor, session.tenant);
  if (actor === undefined) {
    return deny("actor-unavailable");
  }
  const principal = await load(
    options.principals,
    session.principal,
    session.tenant,
  );
  if (principal === undefined) {
    return deny("principal-unavailable");
  }
  const scopes: string[] = [];
  let readOnly = true;
  for (const key of session.permissions) {
    const leaf = findPermission(options.permissions, key);
    if (leaf === undefined) {
      return deny("invalid-claims");
    }
    scopes.push(leaf.scope);
    readOnly &&= annotationsFor(leaf).readOnlyHint;
  }
  return Object.freeze(
    compact<Subject>({
      principal: Object.freeze({ ...principal, tenant: session.tenant }),
      actor: Object.freeze(
        compact({
          id: session.actor,
          kind: "support",
          readOnly: readOnly || undefined,
        }),
      ),
      delegation: Object.freeze({ scopes }),
      context: Object.freeze({
        supportSession: Object.freeze(
          compact<SupportSessionContext>({
            id: session.id,
            reason: session.reason,
            approvedBy: session.approvedBy,
            reference: session.reference,
          }),
        ),
      }),
      expiresAt: secondsOf(session.expiresAt),
    }),
  );
}
