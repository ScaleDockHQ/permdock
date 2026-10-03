import type { StandardSchemaV1 } from "@standard-schema/spec";

import type {
  AuthEvent,
  JwtClaims,
  TokenFailureCause,
  TokenVerifier,
} from "../core/interfaces.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { JoseTokenVerifierOptions } from "./types.ts";

import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { anonymousSubject } from "../core/subject.ts";
import { decodeHeader } from "./header.ts";
import { validateCustomClaims } from "./map-claims.ts";
import { joseTokenVerifier } from "./verifier.ts";

export type CiOidcProvider = "github" | "gitlab" | "buildkite";

const PROVIDERS: Readonly<
  Record<CiOidcProvider, { readonly issuer: string; readonly jwks: string }>
> = {
  github: {
    issuer: "https://token.actions.githubusercontent.com",
    jwks: "https://token.actions.githubusercontent.com/.well-known/jwks",
  },
  gitlab: {
    issuer: "https://gitlab.com",
    jwks: "https://gitlab.com/oauth/discovery/keys",
  },
  buildkite: {
    issuer: "https://agent.buildkite.com",
    jwks: "https://agent.buildkite.com/.well-known/jwks",
  },
};

export type CiOidcSubjectOptions = Omit<
  JoseTokenVerifierOptions,
  "typ" | "issuer" | "audience" | "discovery" | "profile"
> & {
  readonly provider: CiOidcProvider;
  /** The audience the job requested the token for; required. */
  readonly audience: string | readonly string[];
  /**
   * A self-managed GitLab or GitHub Enterprise Server issuer. Its keys come
   * from OpenID discovery unless `jwks` is set.
   */
  readonly issuer?: string;
  /** Validates the verified claims; a failure or a Promise is the anonymous subject. */
  readonly schema?: StandardSchemaV1;
  readonly verifier?: TokenVerifier;
  readonly onAuth?: (event: AuthEvent) => void;
  readonly requestId?: string;
};

/** A CI job: never a user. `ref` is a full ref (`refs/heads/main`, `refs/tags/v1`). */
export type CiOidcPrincipal = Principal & {
  readonly kind: "workload";
  readonly issuer: string;
  readonly provider: CiOidcProvider;
  readonly repository?: string;
  readonly ref?: string;
  readonly environment?: string;
};

function text(claims: JwtClaims, key: string): string | undefined {
  const value = Object.hasOwn(claims, key) ? claims[key] : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function fullRef(
  name: string | undefined,
  type: "branch" | "tag",
): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (name.startsWith("refs/")) {
    return name;
  }
  return type === "tag" ? `refs/tags/${name}` : `refs/heads/${name}`;
}

function jobClaims(
  provider: CiOidcProvider,
  claims: JwtClaims,
): Pick<CiOidcPrincipal, "repository" | "ref" | "environment"> {
  switch (provider) {
    case "github":
      return compact({
        repository: text(claims, "repository"),
        ref: text(claims, "ref"),
        environment: text(claims, "environment"),
      });
    case "gitlab":
      return compact({
        repository: text(claims, "project_path"),
        ref: fullRef(
          text(claims, "ref"),
          text(claims, "ref_type") === "tag" ? "tag" : "branch",
        ),
        environment: text(claims, "environment"),
      });
    case "buildkite": {
      const organization = text(claims, "organization_slug");
      const pipeline = text(claims, "pipeline_slug");
      const tag = text(claims, "build_tag");
      return compact({
        repository:
          organization === undefined || pipeline === undefined
            ? undefined
            : `${organization}/${pipeline}`,
        ref:
          tag === undefined
            ? fullRef(text(claims, "build_branch"), "branch")
            : fullRef(tag, "tag"),
      });
    }
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

/**
 * Resolves a CI provider's OIDC token (GitHub Actions, GitLab CI, Buildkite)
 * into a `workload` principal whose id is `sub`. Every failure (signature,
 * issuer, audience, expiry, a missing `sub`, the `schema`) is the anonymous
 * subject, never a throw and never a user.
 */
export async function subjectFromCiOidc(
  token: string | undefined | null,
  options: CiOidcSubjectOptions,
): Promise<Subject<CiOidcPrincipal> | Subject> {
  if (token === undefined || token === null || token.length === 0) {
    return anonymousSubject();
  }
  const known = Object.hasOwn(PROVIDERS, options.provider)
    ? PROVIDERS[options.provider]
    : undefined;
  const issuer = options.issuer ?? known?.issuer;
  const deny = (cause: TokenFailureCause): Subject => {
    const header = decodeHeader(token);
    options.onAuth?.(
      compact<AuthEvent>({
        reason: "invalid-token",
        cause,
        source: "ci-oidc",
        kid: header?.kid,
        alg: header?.alg,
        typ: header?.typ,
        issuer,
        requestId: options.requestId,
      }),
    );
    return anonymousSubject();
  };
  if (known === undefined || issuer === undefined) {
    return deny("wrong-issuer");
  }
  if (options.audience === undefined || options.audience.length === 0) {
    return deny("wrong-audience");
  }
  let verifier: TokenVerifier;
  try {
    verifier =
      options.verifier ??
      joseTokenVerifier(
        options.issuer === undefined || options.jwks !== undefined
          ? { ...options, issuer, jwks: options.jwks ?? known.jwks }
          : { ...options, issuer, discovery: issuer },
      );
  } catch {
    return deny("malformed");
  }
  let verified: Awaited<ReturnType<TokenVerifier["verify"]>>;
  try {
    verified = await verifier.verify(
      token,
      compact({
        typ: ["JWT"],
        issuer,
        audience: options.audience,
        clockTolerance: options.clockTolerance,
      }),
    );
  } catch {
    return deny("malformed");
  }
  if (!verified.ok) {
    return deny(verified.cause);
  }
  const sub = text(verified.claims, "sub");
  if (sub === undefined) {
    return deny("invalid-claims");
  }
  if (
    options.schema !== undefined &&
    !validateCustomClaims(verified.claims, options.schema).ok
  ) {
    return deny("invalid-claims");
  }
  const principal: CiOidcPrincipal = {
    id: sub,
    kind: "workload",
    issuer,
    provider: options.provider,
    ...jobClaims(options.provider, verified.claims),
  };
  return freezeDeep({ principal, context: {} });
}
