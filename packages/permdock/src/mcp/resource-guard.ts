import type { JwtClaims, TokenVerifier } from "../core/interfaces.ts";
import type { McpAuthInfo } from "./types.ts";

import { compact } from "../core/compact.ts";
import { statusProblem } from "../core/problem-types.ts";
import {
  bearerChallenge,
  methodNotAllowed,
  problemResponse,
  protectedResourceMetadataUrl,
} from "../server/problem.ts";

/**
 * The `error_description` of every `invalid_token` challenge (RFC 6750 section
 * 3.1).
 */
const INVALID_TOKEN = "The access token is invalid";
const BEARER = /^Bearer +([\w~+/.-]+=*)$/iu;

export type McpResourceGuardOptions = {
  /**
   * The MCP server's resource identifier (RFC 8707); a token's `aud` must
   * contain it.
   */
  readonly resource: string | URL;
  /**
   * Scopes every request needs; a token without one of them gets `403
   * insufficient_scope`.
   */
  readonly scopes?: readonly string[];
  readonly verifier: TokenVerifier;
  /**
   * The authorization server's issuer, when the verifier does not check `iss`
   * itself.
   */
  readonly issuer?: string;
  /** `true` for a revoked token; a throw also refuses it. */
  readonly revoked?: (claims: JwtClaims) => boolean | Promise<boolean>;
  /**
   * The RFC 9728 metadata URL in challenges; default
   * `<origin>/.well-known/oauth-protected-resource<path>`.
   */
  readonly resourceMetadataUrl?: string;
};

export type McpResourceGuardResult =
  | { readonly ok: true; readonly authInfo: McpAuthInfo }
  | { readonly ok: false; readonly response: Response };

export type ProtectedResourceMetadataOptions = {
  readonly resource: string | URL;
  /** `authorization_servers`: the issuers whose tokens the resource accepts. */
  readonly authorizationServers: readonly string[];
  /**
   * `scopes_supported`; list every permission's `scope` so clients can ask for
   * them up front.
   */
  readonly scopesSupported?: readonly string[];
  readonly resourceName?: string;
  readonly resourceDocumentation?: string;
};

function tokenScopes(claims: JwtClaims): readonly string[] {
  const { scope, scp } = claims;
  if (typeof scope === "string") {
    return scope.split(" ").filter((name) => name !== "");
  }
  return Array.isArray(scp)
    ? scp.filter((name): name is string => typeof name === "string")
    : [];
}

function refuse(
  status: 401 | 403,
  challenge: string,
  detail: string,
): McpResourceGuardResult {
  return {
    ok: false,
    response: problemResponse(
      statusProblem(status, detail),
      undefined,
      undefined,
      { "WWW-Authenticate": challenge },
    ),
  };
}

/**
 * The resource-server check in front of an MCP endpoint (MCP authorization, RFC
 * 6750, RFC 9728): reads the bearer token from `Authorization`, verifies it for
 * `resource`, refuses a revoked one and checks `scopes`. It answers the
 * `McpAuthInfo` the SDK's handlers read, or the `401` or `403` response with a
 * `WWW-Authenticate` challenge naming the metadata URL. A token in the query
 * string is never read. Never throws.
 */
export function mcpResourceGuard(
  options: McpResourceGuardOptions,
): (request: Request) => Promise<McpResourceGuardResult> {
  const resource = new URL(String(options.resource));
  const resourceMetadata =
    options.resourceMetadataUrl ?? protectedResourceMetadataUrl(resource);
  const required = options.scopes ?? [];
  const invalid = (): McpResourceGuardResult =>
    refuse(
      401,
      bearerChallenge({
        error: "invalid_token",
        description: INVALID_TOKEN,
        resourceMetadata,
      }),
      "invalid access token",
    );

  return async (request) => {
    const header = request.headers.get("authorization");
    if (header === null || header.trim() === "") {
      return refuse(
        401,
        `Bearer resource_metadata="${resourceMetadata}"`,
        "access token required",
      );
    }
    const token = BEARER.exec(header.trim())?.[1];
    if (token === undefined) {
      return invalid();
    }
    let claims: JwtClaims;
    try {
      const verified = await options.verifier.verify(
        token,
        compact({ audience: resource.href, issuer: options.issuer }),
      );
      if (!verified.ok) {
        return invalid();
      }
      claims = verified.claims;
      if (options.revoked !== undefined && (await options.revoked(claims))) {
        return invalid();
      }
    } catch {
      return invalid();
    }
    const scopes = tokenScopes(claims);
    if (required.some((scope) => !scopes.includes(scope))) {
      return refuse(
        403,
        bearerChallenge({
          error: "insufficient_scope",
          scopes: required,
          resourceMetadata,
        }),
        "insufficient scope",
      );
    }
    const clientId = claims["client_id"] ?? claims["azp"];
    return {
      ok: true,
      authInfo: compact<McpAuthInfo>({
        token,
        clientId: typeof clientId === "string" ? clientId : undefined,
        scopes,
        expiresAt: claims.exp,
        resource,
        resourceMetadataUrl: resourceMetadata,
        extra: { claims },
      }),
    };
  };
}

/**
 * The RFC 9728 Protected Resource Metadata document as a Fetch handler, for
 * `/.well-known/oauth-protected-resource<path>`. `bearer_methods_supported` is
 * `header`, the only method `mcpResourceGuard` reads. Any origin may read it.
 */
export function protectedResourceMetadata(
  options: ProtectedResourceMetadataOptions,
): (request: Request) => Response {
  const body = JSON.stringify(
    compact({
      resource: new URL(String(options.resource)).href,
      authorization_servers: options.authorizationServers,
      scopes_supported: options.scopesSupported,
      bearer_methods_supported: ["header"],
      resource_name: options.resourceName,
      resource_documentation: options.resourceDocumentation,
    }),
  );
  return (request) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD, OPTIONS");
    }
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=3600",
      },
    });
  };
}
