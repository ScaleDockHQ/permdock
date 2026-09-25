import type { Membership } from 'permdock';

import { cookies } from 'next/headers';

import type { SessionClaims } from '../policy.ts';

import { membershipsOf } from './store.ts';
import { SESSION_COOKIE, signSession, verifySession } from './token.ts';

export type MembershipMode = 'jwt' | 'database';

export function membershipMode(): MembershipMode {
  return process.env.MEMBERSHIP_MODE === 'database' ? 'database' : 'jwt';
}

export async function getClaims(): Promise<SessionClaims | null> {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
}

/** JWT mode: the token carries memberships, as a Supabase access-token hook would write them. */
export async function mintSession(user: string): Promise<string> {
  return signSession(
    user,
    membershipMode() === 'jwt' ? membershipsOf(user) : undefined,
  );
}

/** Database mode reads memberships per call; JWT mode trusts the verified claim. */
export function membershipsFor(
  claims: SessionClaims,
): readonly Membership[] | undefined {
  return membershipMode() === 'database'
    ? membershipsOf(claims.sub)
    : undefined;
}
