import type {
  AuthInfo,
  AuthMetadataOptions,
} from '@modelcontextprotocol/server';

import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { joseTokenVerifier } from 'permdock/jwt';
import { saasJwks, signSaasToken } from 'permdock/testing/saas';

import {
  CLIENTS,
  ISSUER,
  ORIGIN,
  RESOURCE,
  SCOPES,
  TOKEN_TTL_SECONDS,
} from './config.ts';

export const metadata: AuthMetadataOptions = {
  oauthMetadata: {
    issuer: ISSUER,
    authorization_endpoint: `${ORIGIN}/oauth/authorize`,
    token_endpoint: `${ORIGIN}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
    scopes_supported: [...SCOPES],
  },
  resourceServerUrl: new URL(RESOURCE),
  scopesSupported: [...SCOPES],
  resourceName: 'PermDock SaaS projects',
  dangerouslyAllowInsecureIssuerUrl: true,
};

function tokenError(error: string, status = 400): Response {
  return Response.json(
    { error },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

function basicCredentials(header: string | null): [string, string] | undefined {
  if (header === null || !header.startsWith('Basic ')) {
    return undefined;
  }
  const decoded = atob(header.slice('Basic '.length));
  const at = decoded.indexOf(':');
  if (at === -1) {
    return undefined;
  }
  return [
    decodeURIComponent(decoded.slice(0, at)),
    decodeURIComponent(decoded.slice(at + 1)),
  ];
}

/** RFC 6749 client credentials grant; RFC 8707 `resource` must name this server. */
export async function tokenEndpoint(request: Request): Promise<Response> {
  const credentials = basicCredentials(request.headers.get('authorization'));
  const client =
    credentials !== undefined && Object.hasOwn(CLIENTS, credentials[0])
      ? CLIENTS[credentials[0]]
      : undefined;
  if (credentials === undefined || client?.secret !== credentials[1]) {
    return tokenError('invalid_client', 401);
  }
  const form = new URLSearchParams(await request.text());
  if (form.get('grant_type') !== 'client_credentials') {
    return tokenError('unsupported_grant_type');
  }
  const resource = form.get('resource');
  if (resource !== null && resource !== RESOURCE) {
    return tokenError('invalid_target');
  }
  const requested = form.get('scope')?.split(' ').filter(Boolean);
  const scopes =
    requested === undefined
      ? client.scopes
      : requested.filter((scope) => client.scopes.includes(scope));
  const accessToken = await signSaasToken(client.user, {
    memberships: false,
    issuer: ISSUER,
    audience: RESOURCE,
    ttl: TOKEN_TTL_SECONDS,
    claims: {
      client_id: credentials[0],
      scope: scopes.join(' '),
      tenant: client.tenant,
    },
  });
  return Response.json(
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: scopes.join(' '),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

const jwt = joseTokenVerifier({
  jwks: saasJwks,
  issuer: ISSUER,
  audience: RESOURCE,
  algorithms: ['ES256'],
  typ: 'at+jwt',
});

/** The MCP SDK's `OAuthTokenVerifier`, backed by `permdock/jwt`. */
export const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const verified = await jwt.verify(token, {});
    if (!verified.ok) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, verified.cause);
    }
    const { claims } = verified;
    return {
      token,
      clientId: typeof claims.client_id === 'string' ? claims.client_id : '',
      scopes:
        typeof claims.scope === 'string'
          ? claims.scope.split(' ').filter(Boolean)
          : [],
      ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp } : {}),
      resource: new URL(RESOURCE),
      extra: { ...claims },
    };
  },
};
