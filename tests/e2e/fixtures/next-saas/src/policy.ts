import type { Membership, Subject } from 'permdock';

export { saasPolicy as policy } from '@permdock/testing/saas';

export type SessionClaims = {
  readonly sub: string;
  readonly exp: number;
  readonly iat: number;
  readonly memberships?: readonly Membership[];
};

/**
 * The verified claims as a PermDock subject. `memberships` replaces the
 * claim in database mode; `plans` are the active tenant's plans.
 */
export function subjectOf(
  claims: SessionClaims | null,
  options: {
    readonly memberships?: readonly Membership[];
    readonly plans?: readonly string[];
  } = {},
): Subject | null {
  if (claims === null) {
    return null;
  }
  return {
    principal: {
      id: claims.sub,
      memberships: [...(options.memberships ?? claims.memberships ?? [])],
      plans: [...(options.plans ?? [])],
    },
    context: {},
    expiresAt: claims.exp,
  };
}
