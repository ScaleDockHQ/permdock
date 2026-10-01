import type { JwtClaims } from '../core/interfaces.ts';
import type { Subject } from '../core/subject.ts';
import type { JwtSubjectOptions } from '../jwt/types.ts';
import type { McpAuthInfo, McpPrincipal } from './types.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { anonymousSubject } from '../core/subject.ts';
import { mapClaimsToSubject } from '../jwt/map-claims.ts';

export type McpSubjectOptions = Pick<
  JwtSubjectOptions,
  'claims' | 'groupRoles' | 'schema' | 'delegation'
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Maps the `AuthInfo` the MCP SDK's bearer verification produced to a
 * `Subject`: the principal from the verified claims in `extra`, the client
 * as an `mcp-client` actor, the granted scopes as the delegation. Never
 * verifies and never throws; anything unusable is the anonymous subject.
 */
export function subjectFromMcp(
  authInfo: McpAuthInfo | undefined,
  options: McpSubjectOptions = {},
): Subject<McpPrincipal> {
  try {
    if (authInfo === undefined || !isRecord(authInfo.extra)) {
      return anonymousSubject();
    }
    // SAFETY: extra is checked to be a record above; mapClaimsToSubject type-checks each claim it reads.
    const claims = compact<JwtClaims>({
      ...(authInfo.extra as JwtClaims),
      authorization_details:
        authInfo.extra['authorizationDetails'] ??
        authInfo.extra['authorization_details'],
      scope: authInfo.scopes?.join(' '),
      client_id: authInfo.clientId,
      exp: authInfo.expiresAt,
    });
    const mapped = mapClaimsToSubject(claims, options);
    if (
      mapped.invalidClaims ||
      mapped.invalidChain ||
      mapped.subject.principal === null
    ) {
      return anonymousSubject();
    }
    const clientId = authInfo.clientId;
    // SAFETY: McpPrincipal only adds optional fields to the Principal mapClaimsToSubject builds.
    return freezeDeep(
      compact({
        ...mapped.subject,
        actor:
          typeof clientId === 'string' && clientId !== ''
            ? { id: clientId, kind: 'mcp-client' as const }
            : mapped.subject.actor,
      }),
    ) as Subject<McpPrincipal>;
  } catch {
    return anonymousSubject();
  }
}
