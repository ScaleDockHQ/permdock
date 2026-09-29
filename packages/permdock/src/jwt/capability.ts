import type {
  Capability,
  LinkPolicy,
  LinkPrincipal,
} from '../core/capability.ts';
import type {
  AuthEvent,
  TokenFailureCause,
  TokenVerifier,
} from '../core/interfaces.ts';
import type { Subject } from '../core/subject.ts';
import type { ReplayStore } from '../ssf/types.ts';
import type { JoseTokenVerifierOptions } from './types.ts';

import {
  capabilitySubject,
  linkPolicyViolation,
  parseCapability,
  redeemerAllows,
} from '../core/capability.ts';
import { compact } from '../core/compact.ts';
import { anonymousSubject } from '../core/subject.ts';
import { decodeHeader, normalizeTyp } from './header.ts';
import { joseTokenVerifier } from './verifier.ts';

/** `on('auth')` causes: a verification failure, or one of the three capability checks. */
export type CapabilityFailureCause =
  | TokenFailureCause
  | 'capability-revoked'
  | 'capability-replayed'
  | 'redeemer-mismatch'
  | 'link-policy';

export type CapabilitySubjectOptions = Omit<
  JoseTokenVerifierOptions,
  'typ' | 'issuer' | 'audience' | 'profile'
> & {
  /** The issuer the capability was signed by (`iss`); required. */
  readonly issuer: string;
  /** The application the capability was signed for (`aud`); required. */
  readonly audience: string | readonly string[];
  readonly verifier?: TokenVerifier;
  /**
   * The link policies of the scope instances the linked resource sits in
   * (its tenant, its customer); every one must hold. A throw denies.
   */
  readonly linkPolicy?: (
    capability: Capability,
  ) =>
    | LinkPolicy
    | readonly LinkPolicy[]
    | undefined
    | Promise<LinkPolicy | readonly LinkPolicy[] | undefined>;
  /** `true` when the application revoked the link id (`sub`); a throw denies. */
  readonly revoked?: (id: string) => boolean | Promise<boolean>;
  /** Claims the `jti` of a one-time capability; a one-time capability without it is refused. */
  readonly replay?: ReplayStore;
  /** The request's own verified subject, checked against the capability's `redeemer`. */
  readonly viewer?: Subject;
  readonly onAuth?: (event: AuthEvent) => void;
  readonly requestId?: string;
};

type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AuthEvent['reason'] };

function emit(
  options: CapabilitySubjectOptions,
  reason: AuthEvent['reason'],
  cause: CapabilityFailureCause | undefined,
  token: string,
): void {
  if (options.onAuth === undefined) {
    return;
  }
  const header = decodeHeader(token);
  options.onAuth(
    compact<AuthEvent>({
      reason,
      cause,
      source: 'capability',
      kid: header?.kid,
      alg: header?.alg,
      typ: header?.typ,
      issuer: options.issuer,
      requestId: options.requestId,
    }),
  );
}

async function claimOnce(
  replay: ReplayStore,
  key: string,
  expiresAt: number,
): Promise<boolean> {
  if (replay.claim !== undefined) {
    return replay.claim(key, expiresAt);
  }
  if (await replay.seen(key)) {
    return false;
  }
  await replay.remember(key, expiresAt);
  return true;
}

async function stores(
  options: CapabilitySubjectOptions,
  capability: Capability,
  issuedAt: number | undefined,
  once: { readonly key: string; readonly expiresAt: number } | undefined,
): Promise<Outcome | CapabilityFailureCause> {
  try {
    const policy = await options.linkPolicy?.(capability);
    if (
      policy !== undefined &&
      linkPolicyViolation(capability, policy, issuedAt) !== undefined
    ) {
      return 'link-policy';
    }
    if (
      options.revoked !== undefined &&
      (await options.revoked(capability.id))
    ) {
      return 'capability-revoked';
    }
    if (
      once !== undefined &&
      !(await claimOnce(options.replay!, once.key, once.expiresAt))
    ) {
      return 'capability-replayed';
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'source-threw' };
  }
}

/**
 * Resolves a `permdock-capability+jwt` into the `link` subject it acts as.
 * Every failure (signature, `typ`, `iss`, `aud`, expiry, a malformed claim,
 * a revoked link, a replayed one-time token, a redeemer the viewer does not
 * satisfy, a throwing store) is the anonymous subject, never a throw.
 */
export async function subjectFromCapability(
  token: string | undefined | null,
  options: CapabilitySubjectOptions,
): Promise<Subject<LinkPrincipal> | Subject> {
  if (token === undefined || token === null || token.length === 0) {
    return anonymousSubject();
  }
  const deny = (
    cause: CapabilityFailureCause | undefined,
    reason: AuthEvent['reason'] = 'invalid-token',
  ): Subject => {
    emit(options, reason, cause, token);
    return anonymousSubject();
  };
  if (typeof options.issuer !== 'string' || options.issuer.length === 0) {
    return deny('wrong-issuer');
  }
  if (options.audience === undefined || options.audience.length === 0) {
    return deny('wrong-audience');
  }
  let verifier: TokenVerifier;
  try {
    verifier =
      options.verifier ??
      joseTokenVerifier({
        ...options,
        typ: 'permdock-capability+jwt',
      });
  } catch {
    return deny('malformed');
  }
  const verified = await verifier.verify(
    token,
    compact({
      typ: 'permdock-capability+jwt',
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: options.clockTolerance,
    }),
  );
  if (!verified.ok) {
    return deny(verified.cause);
  }
  if (normalizeTyp(verified.header.typ) !== 'permdock-capability+jwt') {
    return deny('wrong-token-type');
  }
  const parsed = parseCapability(verified.claims.capability);
  const exp = verified.claims.exp;
  if (
    parsed === undefined ||
    parsed.holder !== 'link' ||
    verified.claims.sub !== parsed.id ||
    typeof exp !== 'number'
  ) {
    return deny('invalid-claims');
  }
  const capability = { ...parsed, expiresAt: Math.min(parsed.expiresAt, exp) };
  const now = Date.now() / 1000;
  if (capability.expiresAt <= now) {
    return deny('expired');
  }
  if (!redeemerAllows(capability.redeemer, options.viewer, now)) {
    return deny('redeemer-mismatch');
  }
  const jti = verified.claims.jti;
  if (
    capability.once === true &&
    (options.replay === undefined || typeof jti !== 'string' || jti === '')
  ) {
    return deny('invalid-claims');
  }
  const iat = verified.claims.iat;
  const checked = await stores(
    options,
    capability,
    typeof iat === 'number' ? iat : undefined,
    capability.once === true
      ? {
          key: `capability\u0000${options.issuer}\u0000${String(jti)}`,
          expiresAt: capability.expiresAt,
        }
      : undefined,
  );
  if (typeof checked === 'string') {
    return deny(checked);
  }
  if (!checked.ok) {
    return deny(undefined, checked.reason);
  }
  return capabilitySubject(capability, { issuer: options.issuer });
}
