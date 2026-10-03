import type { JwtClaims } from "../core/interfaces.ts";
import type { Actor, Binding } from "../core/subject.ts";
import type { JwtSubjectOptions, MappedSubject } from "./types.ts";

import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { anonymousSubject } from "../core/subject.ts";
import { mapClaimsToSubject } from "./map-claims.ts";

function emitAuth(options: JwtSubjectOptions, cause: "invalid-chain"): void {
  if (options.onAuth === undefined) {
    return;
  }
  options.onAuth(
    compact({
      reason: "invalid-token" as const,
      cause,
      source: "jwt" as const,
      issuer: options.issuer,
      requestId: options.requestId,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keyToCnf(key: unknown): JwtClaims["cnf"] {
  if (!isRecord(key)) {
    return undefined;
  }
  if (isRecord(key["jwk"])) {
    return { jwk: key["jwk"] };
  }
  return { jwk: key };
}

function introspectionToClaims(body: Record<string, unknown>): JwtClaims {
  const cnf = keyToCnf(body["key"]);
  // SAFETY: the RFC 7662 response comes from the authorization server; aud is only compared by value.
  return compact<JwtClaims>({
    sub: typeof body["sub"] === "string" ? body["sub"] : undefined,
    iss: typeof body["iss"] === "string" ? body["iss"] : undefined,
    aud: body["aud"] as JwtClaims["aud"],
    exp: typeof body["exp"] === "number" ? body["exp"] : undefined,
    iat: typeof body["iat"] === "number" ? body["iat"] : undefined,
    nbf: typeof body["nbf"] === "number" ? body["nbf"] : undefined,
    jti: typeof body["jti"] === "string" ? body["jti"] : undefined,
    scope: typeof body["scope"] === "string" ? body["scope"] : undefined,
    authorization_details: body["authorization_details"],
    access: body["access"],
    client_id:
      typeof body["client_id"] === "string" ? body["client_id"] : undefined,
    roles: body["roles"],
    groups: body["groups"],
    entitlements: body["entitlements"],
    sid: typeof body["sid"] === "string" ? body["sid"] : undefined,
    acr: typeof body["acr"] === "string" ? body["acr"] : undefined,
    amr: body["amr"],
    auth_time: body["auth_time"],
    act: body["act"],
    cnf,
  });
}

function instanceActor(body: Record<string, unknown>): Actor | undefined {
  const id =
    typeof body["instance_id"] === "string"
      ? body["instance_id"]
      : typeof body["client_id"] === "string"
        ? body["client_id"]
        : undefined;
  if (id === undefined) {
    return undefined;
  }
  return { id, kind: "oauth-client" };
}

function attachActor(
  subject: MappedSubject,
  body: Record<string, unknown>,
  binding: Binding | undefined,
): MappedSubject {
  if (subject.actor !== undefined) {
    return subject;
  }
  const actor = instanceActor(body);
  if (actor === undefined) {
    return subject;
  }
  const principal = subject.principal;
  if (principal === null) {
    return subject;
  }
  return freezeDeep({
    ...subject,
    principal: freezeDeep(compact({ ...principal, binding: undefined })),
    actor: freezeDeep(compact<Actor>({ ...actor, binding })),
  });
}

/**
 * RFC 7662 leaves `aud` and `iss` optional; a response that names another
 * resource server or issuer than the one configured is not for this API.
 */
function boundToConfig(
  body: Record<string, unknown>,
  options: JwtSubjectOptions,
): boolean {
  if (
    options.issuer !== undefined &&
    body["iss"] !== undefined &&
    body["iss"] !== options.issuer
  ) {
    return false;
  }
  if (options.audience === undefined) {
    return true;
  }
  const expected = Array.isArray(options.audience)
    ? options.audience
    : [options.audience];
  const aud = body["aud"];
  const held = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  return held.some((item) => expected.includes(item));
}

export function subjectFromIntrospection(
  response: unknown,
  options: JwtSubjectOptions = {},
): MappedSubject {
  try {
    if (
      !isRecord(response) ||
      response["active"] !== true ||
      !boundToConfig(response, options)
    ) {
      return anonymousSubject();
    }
    const mapped = mapClaimsToSubject(introspectionToClaims(response), options);
    if (mapped.invalidChain) {
      emitAuth(options, "invalid-chain");
      return anonymousSubject();
    }
    if (mapped.subject.principal === null) {
      return anonymousSubject();
    }
    // SAFETY: a non-null principal from mapClaimsToSubject is a JwtPrincipal (checked above).
    return attachActor(
      mapped.subject as MappedSubject,
      response,
      mapped.subject.principal.binding,
    );
  } catch {
    return anonymousSubject();
  }
}
