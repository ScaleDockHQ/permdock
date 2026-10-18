import { isRecord } from "../../../src/core/compact.ts";
import { POLICY_NOT_PUBLISHED } from "../../../src/testing/cloud-api/platform.ts";

/** The platform's deliberate contract breaks; `testCloudApi` must reject each. */
export type ReferencePlatformMutation =
  | "no-ratelimit"
  | "token-writes"
  | "policy-404-plain";

/** One `cloud push` as the reference Cloud holds it. */
export type PushedEntry = {
  readonly version: number;
  readonly fingerprint: string;
  readonly catalog: Readonly<Record<string, unknown>>;
  readonly policy?: unknown;
  readonly manifest?: unknown;
  readonly permdockVersion?: unknown;
};

export type ReferencePlatform = {
  /** The read-only `PERMDOCK_CLOUD_TOKEN` pinned to the environment. */
  readonly token: string;
  /** A login with `projects:read policy:read`, for every project of the person. */
  readonly login: string;
  /** A project of the person with nothing pushed. */
  readonly unpublished: string;
  /** Tokens revoked through `/oauth/revoke`. */
  readonly revoked: ReadonlySet<string>;
  /** The scopes of a token this issuer issued, or `null`. */
  readonly scopeOf: (token: string) => string | null;
  readonly handles: (pathname: string) => boolean;
  readonly handle: (request: Request) => Promise<Response>;
};

type Options = {
  readonly base: string;
  readonly environment: string;
  readonly latest: () => PushedEntry | undefined;
  readonly mutation: string | undefined;
};

const READ_TOKEN = "pt_read_test";
const LOGIN_TOKEN = "at_login_test";
const UNPUBLISHED = "empty";

function problem(
  status: number,
  title: string,
  type = "about:blank",
  plain = false,
): Response {
  return Response.json(
    { type, title, status },
    {
      status,
      headers: {
        "content-type": plain ? "application/json" : "application/problem+json",
      },
    },
  );
}

const oauthError = (error: string, status = 400): Response =>
  Response.json({ error }, { status });

async function form(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}

function loopbackOrHttps(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/** The platform issuer and the project read API of the reference Cloud. */
export function referencePlatform(options: Options): ReferencePlatform {
  const { base, environment, mutation } = options;
  const scopes = new Map<string, string>([
    [LOGIN_TOKEN, "projects:read policy:read"],
  ]);
  const refreshes = new Map<string, string>();
  const devices = new Map<string, string>();
  const codes = new Map<
    string,
    {
      readonly challenge: string;
      readonly redirect: string;
      readonly scope: string;
    }
  >();
  const revoked = new Set<string>();
  const projects = [
    { id: environment, name: "Reference", environment },
    { id: UNPUBLISHED, name: "Empty", environment: UNPUBLISHED },
  ];

  const issue = (scope: string): Response => {
    const access = `at_${crypto.randomUUID()}`;
    const refresh = `rt_${crypto.randomUUID()}`;
    scopes.set(access, scope);
    refreshes.set(refresh, scope);
    return Response.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope,
    });
  };

  const limited = (body: unknown): Response =>
    Response.json(body, {
      headers:
        mutation === "no-ratelimit"
          ? {}
          : {
              RateLimit: '"read";r=59;t=30',
              "RateLimit-Policy": '"read";q=60;w=60',
            },
    });

  const metadata = (): Response =>
    Response.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      device_authorization_endpoint: `${base}/oauth/device_authorization`,
      token_endpoint: `${base}/oauth/token`,
      revocation_endpoint: `${base}/oauth/revoke`,
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: ["projects:read", "policy:read", "catalog:write"],
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: [
        "authorization_code",
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none"],
    });

  async function token(request: Request): Promise<Response> {
    const fields = await form(request);
    const grant = fields.get("grant_type");
    if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
      const scope = devices.get(fields.get("device_code") ?? "");
      if (scope === undefined) {
        return oauthError("expired_token");
      }
      devices.delete(fields.get("device_code") ?? "");
      return issue(scope);
    }
    if (grant === "authorization_code") {
      const code = codes.get(fields.get("code") ?? "");
      codes.delete(fields.get("code") ?? "");
      if (
        code === undefined ||
        code.redirect !== fields.get("redirect_uri") ||
        code.challenge !== (await s256(fields.get("code_verifier") ?? ""))
      ) {
        return oauthError("invalid_grant");
      }
      return issue(code.scope);
    }
    if (grant === "refresh_token") {
      const scope = refreshes.get(fields.get("refresh_token") ?? "");
      if (scope === undefined) {
        return oauthError("invalid_grant");
      }
      refreshes.delete(fields.get("refresh_token") ?? "");
      return issue(scope);
    }
    return oauthError("unsupported_grant_type");
  }

  function authorize(request: Request): Response {
    const query = new URL(request.url).searchParams;
    const redirect = query.get("redirect_uri") ?? "";
    const challenge = query.get("code_challenge") ?? "";
    if (
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256" ||
      challenge === "" ||
      !loopbackOrHttps(redirect)
    ) {
      return oauthError("invalid_request");
    }
    const code = `code_${crypto.randomUUID()}`;
    codes.set(code, {
      challenge,
      redirect,
      scope: query.get("scope") ?? "projects:read policy:read",
    });
    const location = new URL(redirect);
    location.searchParams.set("code", code);
    const state = query.get("state");
    if (state !== null) {
      location.searchParams.set("state", state);
    }
    return new Response(null, {
      status: 302,
      headers: { location: location.href },
    });
  }

  async function register(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => null);
    const uris =
      isRecord(body) && Array.isArray(body["redirect_uris"])
        ? body["redirect_uris"]
        : [];
    if (
      uris.length === 0 ||
      !uris.every((uri) => typeof uri === "string" && loopbackOrHttps(uri))
    ) {
      return oauthError("invalid_redirect_uri");
    }
    return Response.json(
      {
        client_id: `mcp_${crypto.randomUUID()}`,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
      },
      { status: 201 },
    );
  }

  function readable(bearer: string, scope: string): ReadonlySet<string> | null {
    if (bearer === READ_TOKEN) {
      return new Set([environment]);
    }
    const granted = scopes.get(bearer);
    return granted?.split(" ").includes(scope) === true
      ? new Set(projects.map((project) => project.id))
      : null;
  }

  function read(request: Request, path: string): Response {
    const bearer =
      request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
    const [, , , id, leaf] = path.split("/");
    const scope = leaf === "policy" ? "policy:read" : "projects:read";
    const allowed = readable(bearer, scope);
    if (allowed === null) {
      return problem(401, "Missing, expired or revoked token");
    }
    if (id === undefined) {
      return limited({
        items: projects.filter((project) => allowed.has(project.id)),
      });
    }
    const project = projects.find((item) => item.id === decodeURIComponent(id));
    if (project === undefined) {
      return problem(404, "No such project");
    }
    if (!allowed.has(project.id)) {
      return problem(403, "The token may not read this project");
    }
    if (leaf === undefined) {
      const latest = options.latest();
      return limited({
        ...project,
        issuer: `${base}/v1/environments/${project.environment}`,
        ...(latest === undefined || project.id !== environment
          ? {}
          : {
              catalog: {
                version: latest.version,
                fingerprint: latest.fingerprint,
              },
            }),
      });
    }
    const latest = project.id === environment ? options.latest() : undefined;
    if (latest === undefined) {
      return problem(
        404,
        "Nothing pushed yet",
        POLICY_NOT_PUBLISHED,
        mutation === "policy-404-plain",
      );
    }
    return limited({
      v: 1,
      project: project.id,
      version: latest.version,
      fingerprint: latest.fingerprint,
      permdockVersion:
        typeof latest.permdockVersion === "string"
          ? latest.permdockVersion
          : "0.0.0",
      catalog: latest.catalog,
      ...(latest.manifest === undefined ? {} : { manifest: latest.manifest }),
      ...(latest.policy === undefined ? {} : { policy: latest.policy }),
    });
  }

  const handle = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    if (route === "GET /.well-known/oauth-authorization-server") {
      return metadata();
    }
    if (route === "POST /oauth/device_authorization") {
      const fields = await form(request);
      const code = `dc_${crypto.randomUUID()}`;
      devices.set(code, fields.get("scope") ?? "projects:read policy:read");
      return Response.json({
        device_code: code,
        user_code: "PERM-DOCK",
        verification_uri: `${base}/device`,
        verification_uri_complete: `${base}/device?user_code=PERM-DOCK`,
        expires_in: 600,
        interval: 0,
      });
    }
    if (route === "POST /oauth/token") {
      return token(request);
    }
    if (route === "GET /oauth/authorize") {
      return authorize(request);
    }
    if (route === "POST /oauth/revoke") {
      const value = (await form(request)).get("token") ?? "";
      revoked.add(value);
      scopes.delete(value);
      refreshes.delete(value);
      return new Response(null, { status: 200 });
    }
    if (route === "POST /oauth/register") {
      return register(request);
    }
    if (request.method === "GET" && pathname.startsWith("/v1/projects")) {
      return read(request, pathname);
    }
    return problem(404, "Unknown route");
  };

  return {
    token: READ_TOKEN,
    login: LOGIN_TOKEN,
    unpublished: UNPUBLISHED,
    revoked,
    scopeOf: (value) =>
      value === READ_TOKEN ? "read-only" : (scopes.get(value) ?? null),
    handles: (pathname) =>
      pathname.startsWith("/oauth/") ||
      pathname === "/.well-known/oauth-authorization-server" ||
      pathname === "/v1/projects" ||
      pathname.startsWith("/v1/projects/"),
    handle,
  };
}
