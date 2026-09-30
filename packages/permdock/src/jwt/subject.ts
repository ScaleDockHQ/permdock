import type { AuthEvent, JwtClaims } from '../core/interfaces.ts';
import type { Membership } from '../core/subject.ts';
import type { JwtSubjectOptions, MappedSubject } from './types.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { anonymousSubject } from '../core/subject.ts';
import { assertSubjectConfig, issuerFromDiscovery } from './config.ts';
import { verifyDpopProof } from './dpop.ts';
import { decodeHeader } from './header.ts';
import { acceptMismatch, mapClaimsToSubject } from './map-claims.ts';
import { joseTokenVerifier } from './verifier.ts';

function emitAuth(
  options: JwtSubjectOptions,
  cause: AuthEvent['cause'],
  token: string | undefined,
): void {
  if (options.onAuth === undefined) {
    return;
  }
  const header = token === undefined ? undefined : decodeHeader(token);
  options.onAuth(
    compact<AuthEvent>({
      reason: 'invalid-token',
      cause,
      source: 'jwt',
      kid: header?.kid,
      alg: header?.alg,
      typ: header?.typ,
      issuer: options.issuer,
      requestId: options.requestId,
    }),
  );
}

function tokenInQuery(request: Request | undefined): boolean {
  if (request === undefined) {
    return false;
  }
  const url = new URL(request.url, 'https://permdock.invalid');
  return url.searchParams.has('access_token');
}

function mtlsThumbprint(claims: JwtClaims): string | undefined {
  const cnf = claims['cnf'];
  if (cnf === null || typeof cnf !== 'object' || Array.isArray(cnf)) {
    return undefined;
  }
  const value = (cnf as { readonly 'x5t#S256'?: unknown })['x5t#S256'];
  return typeof value === 'string' ? value : undefined;
}

async function extraMemberships(
  options: JwtSubjectOptions,
  subject: MappedSubject,
  tenant: string | undefined,
): Promise<MappedSubject> {
  if (options.memberships === undefined || subject.principal === null) {
    return subject;
  }
  try {
    const extra = await options.memberships.membershipsFor(
      compact({ id: subject.principal.id, kind: subject.principal.kind }),
      compact({ tenant }),
    );
    if (extra.length === 0) {
      return subject;
    }
    const merged: Membership[] = [
      ...(subject.principal.memberships ?? []),
      ...extra,
    ];
    return freezeDeep({
      ...subject,
      principal: { ...subject.principal, memberships: merged },
    });
  } catch {
    return subject;
  }
}

export function subjectFromJwt(
  token: string | undefined | null,
  options: JwtSubjectOptions,
  request?: Request,
): Promise<MappedSubject> {
  return resolveSubject(token, options, request);
}

export function createJwtSubjectResolver(
  options: JwtSubjectOptions,
): (
  token: string | undefined | null,
  request?: Request,
) => Promise<MappedSubject> {
  assertSubjectConfig(options);
  const verifier = options.verifier ?? joseTokenVerifier(options);
  return (token, request) =>
    resolveSubject(token, { ...options, verifier }, request);
}

async function resolveSubject(
  token: string | undefined | null,
  options: JwtSubjectOptions,
  request?: Request,
): Promise<MappedSubject> {
  if (options.verifier === undefined) {
    assertSubjectConfig(options);
  }
  if (token === undefined || token === null || token.length === 0) {
    return anonymousSubject();
  }
  if (options.profile === 'fapi2' && tokenInQuery(request)) {
    emitAuth(options, 'token-in-query', token);
    return anonymousSubject();
  }
  const verifier = options.verifier ?? joseTokenVerifier(options);
  const issuer =
    options.issuer ??
    (options.discovery === undefined
      ? undefined
      : issuerFromDiscovery(options.discovery));
  const verified = await verifier.verify(
    token,
    compact({
      audience: options.audience,
      issuer,
      clockTolerance: options.clockTolerance,
      typ:
        options.accept === 'id-token'
          ? ['JWT']
          : options.profile === 'fapi2'
            ? 'at+jwt'
            : ['at+jwt', 'JWT'],
    }),
  );
  if (!verified.ok) {
    emitAuth(options, verified.cause, token);
    return anonymousSubject();
  }
  if (
    acceptMismatch(
      verified.claims,
      verified.header.typ,
      options,
      options.audience,
    )
  ) {
    emitAuth(options, 'wrong-token-type', token);
    return anonymousSubject();
  }
  const sender =
    options.sender ?? (options.profile === 'fapi2' ? 'dpop' : 'none');
  const cnf = verified.claims['cnf'];
  const hasCnf = cnf !== null && typeof cnf === 'object';
  if (options.profile === 'fapi2' && !hasCnf) {
    emitAuth(options, 'sender-constraint-required', token);
    return anonymousSubject();
  }
  if (sender === 'dpop' && request !== undefined) {
    const proof = await verifyDpopProof(request, verified.claims, token);
    if (!proof.ok) {
      emitAuth(options, proof.cause, token);
      return anonymousSubject();
    }
  }
  if (sender === 'mtls') {
    const expected = options.certificateThumbprint;
    const seen = mtlsThumbprint(verified.claims);
    if (expected === undefined || seen !== expected) {
      emitAuth(options, 'mtls-binding-mismatch', token);
      return anonymousSubject();
    }
  }
  const mapped = mapClaimsToSubject(verified.claims, options);
  if (mapped.invalidChain) {
    emitAuth(options, 'invalid-chain', token);
    return anonymousSubject();
  }
  if (mapped.subject.principal === null) {
    emitAuth(options, 'invalid-claims', token);
    return anonymousSubject();
  }
  if (mapped.invalidClaims) {
    emitAuth(options, 'invalid-claims', token);
  }
  return extraMemberships(
    options,
    mapped.subject as MappedSubject,
    mapped.subject.principal.tenant,
  );
}
