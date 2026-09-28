import type { JwtClaims } from '../core/interfaces.ts';
import type { SetSubject, SsfSubject } from './types.ts';

import { compact } from '../core/compact.ts';
import { isRecord } from './wire.ts';

export function asSubject(
  mapped: string | SsfSubject,
  session: string | undefined,
  issuer: string | undefined,
): SsfSubject {
  if (typeof mapped === 'string') {
    return compact({ id: mapped, session, issuer });
  }
  return compact({
    id: mapped.id,
    session: mapped.session ?? session,
    issuer: mapped.issuer ?? issuer,
  });
}

export function setSubjectFromClaims(
  claims: JwtClaims,
): SetSubject | undefined {
  const subId = claims.sub_id;
  if (isRecord(subId) && typeof subId.format === 'string') {
    return subId as SetSubject;
  }
  if (typeof claims.sub === 'string' && claims.sub.length > 0) {
    return compact({
      format: 'iss_sub',
      iss: typeof claims.iss === 'string' ? claims.iss : undefined,
      sub: claims.sub,
    });
  }
  return undefined;
}

export function eventTimestamp(
  payload: Readonly<Record<string, unknown>>,
): number | undefined {
  const value = payload.event_timestamp;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function eventSession(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  if (typeof payload.session === 'string' && payload.session.length > 0) {
    return payload.session;
  }
  if (typeof payload.sid === 'string' && payload.sid.length > 0) {
    return payload.sid;
  }
  return undefined;
}

/** CAEP drafts before SSF 1.0 put the subject in the event instead of `sub_id`. */
export function eventSubject(
  payload: Readonly<Record<string, unknown>>,
): SetSubject | undefined {
  const subject = payload.subject;
  return isRecord(subject) && typeof subject.format === 'string'
    ? (subject as SetSubject)
    : undefined;
}

export function subjectSession(subject: SetSubject): string | undefined {
  if (subject.format !== 'complex' || !isRecord(subject.session)) {
    return undefined;
  }
  const { id } = subject.session;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}
