import type { PermDock, Snapshot, Subject } from 'permdock';

import {
  SAAS_TOKEN_TTL_SECONDS,
  saasPolicy,
  signSaasToken,
  verifySaasSession,
} from '@permdock/testing/saas';
import { createPermDock, memoryRoleSource, snapshotFor } from 'permdock';

import { findOrg, membershipsOf } from './store.ts';

export const SESSION_COOKIE = 'saas_session';

export const USERS = [
  'alice',
  'bob',
  'carol',
  'dave',
  'erin',
  'frank',
  'gina',
  'hank',
  'mallory',
] as const;

export type SaasUser = (typeof USERS)[number];

export function isUser(value: unknown): value is SaasUser {
  return USERS.some((user) => user === value);
}

export type Session = { readonly sub: string; readonly expiresAt: number };

/** Identity only: memberships are read from the store on every call. */
export function mintSession(user: SaasUser): Promise<string> {
  return signSaasToken(user, { memberships: false });
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(SAAS_TOKEN_TTL_SECONDS)}`;
}

export const clearedCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function readCookie(
  header: string | null | undefined,
  name: string = SESSION_COOKIE,
): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return rest.join('=');
    }
  }
  return undefined;
}

/** Verifies the session cookie; `null` for a missing, forged or expired token. */
export function readSession(
  cookieHeader: string | null | undefined,
): Promise<Session | null> {
  return verifySaasSession(readCookie(cookieHeader));
}

/** The org the subject is evaluated in; memberships and plan come from the store. */
export function saasSubject(
  session: Session | null,
  org: string,
): Subject | null {
  if (session === null) {
    return null;
  }
  const view = findOrg(org);
  return {
    principal: {
      id: session.sub,
      memberships: membershipsOf(session.sub),
      plans: view === undefined ? [] : [view.plan],
    },
    context: {},
    expiresAt: session.expiresAt,
  };
}

/** Enforcement: a fresh instance per request, never cached. */
export function saasPermDock(
  session: Session | null,
  org: string,
): Promise<PermDock> {
  return Promise.resolve(
    createPermDock(saasPolicy, saasSubject(session, org), {
      tenant: org,
      customRoles: memoryRoleSource(findOrg(org)?.customRoles ?? []),
    }),
  );
}

export function saasSnapshot(session: Session | null, org: string): Snapshot {
  const view = findOrg(org);
  return snapshotFor(saasPolicy, saasSubject(session, org), {
    tenant: org,
    customRoles: view?.customRoles ?? [],
    plans: view === undefined ? [] : [view.plan],
  });
}
