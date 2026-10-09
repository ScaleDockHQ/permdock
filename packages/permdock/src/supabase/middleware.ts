import { type Middleware, defineMiddleware } from "@supabase/middleware";

import type { Credential } from "../core/credential.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission, PermissionTree } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { ServerAdapterServices } from "../server/bind.ts";
import type { OpenApiHooks } from "../server/create.ts";

import { compact } from "../core/compact.ts";
import { credentialSubject } from "../core/credential.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { attached } from "../server/bind.ts";
import { createServerKernel } from "../server/create.ts";
import { methodNotAllowed } from "../server/problem.ts";

/**
 * The verified Supabase Auth access-token payload as `@supabase/server`
 * contributes it under `ctx.jwtClaims`. Structural, so the `JWTClaims`
 * interface from `@supabase/server` satisfies it without an import.
 */
export type SupabaseJwtClaims = {
  readonly sub: string;
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly iat?: number;
  readonly role?: string;
  readonly email?: string;
  readonly app_metadata?: Readonly<Record<string, unknown>>;
  readonly user_metadata?: Readonly<Record<string, unknown>>;
  readonly [claim: string]: unknown;
};

/**
 * What `withPermDock` requires upstream: a `jwtClaims` contribution. Supabase's
 * `withClaims`, `withRequiredClaims` and `withSupabase` all provide it; `null`
 * is the anonymous caller (no bearer token or an `sb_*` API key), unless
 * `secretKeys` names the secret key `withSupabase` matched.
 */
export type SupabaseMiddlewareContext = {
  readonly jwtClaims: SupabaseJwtClaims | null;
};

/**
 * A Supabase secret key that acts as a tenant service principal. `id` is the
 * principal id, `roles` are held in `tenant` only, and `permissions` caps
 * what the key may do, as a `service` credential does.
 */
export type SupabaseSecretKey = {
  readonly id: string;
  readonly tenant: string;
  readonly roles: readonly string[];
  readonly permissions: readonly Permission[];
};

export type SupabaseMiddlewarePermDockOptions<TUser = unknown> =
  InstanceOptions &
    ServerAdapterServices & {
      /**
       * Named secret keys (`SUPABASE_SECRET_KEYS`) that act as service
       * principals when `withSupabase` matched one (`authMode: 'secret'` with
       * that `authKeyName`). Any other key, an unnamed `secret` and every
       * `publishable` key stay anonymous.
       */
      readonly secretKeys?: Readonly<Record<string, SupabaseSecretKey>>;
      readonly subject: (
        ctx: SupabaseMiddlewareContext,
        request: Request,
      ) => TUser | Subject | null | Promise<TUser | Subject | null>;
      readonly tenant?:
        | string
        | ((
            ctx: SupabaseMiddlewareContext,
            request: Request,
          ) => string | undefined | Promise<string | undefined>);
    };

export type WithPermDockConfig = {
  /** Run `protect` before the handler; a denial short-circuits with Problem Details. */
  readonly protect?: Permission;
  /**
   * The OAuth scopes that reach the handler: a delegated token holding none
   * of them is refused with `insufficient_scope`. Without `protect`, the
   * handler needs a signed-in principal and checks no permission.
   */
  readonly oauthScopes?: readonly string[];
  /** Load the row `protect` decides on; `null` or `undefined` yields 404. */
  readonly data?: (ctx: SupabaseMiddlewareContext, request: Request) => unknown;
  /** `true` when `data` returns a row the server loaded; anything else is validated before the check. */
  readonly trusted?: boolean;
};

/**
 * A terminal pipeline handler. Generic over the accumulated context so
 * `pipeline([withClaims()], permdockHandler())` infers without a wrapping
 * lambda; the constraint still requires an upstream `jwtClaims` contribution.
 */
export type SupabaseMiddlewareHandler = <Ctx extends SupabaseMiddlewareContext>(
  request: Request,
  ctx: Ctx,
) => Promise<Response>;

export type SupabaseMiddlewarePermDock<
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  readonly withPermDock: Middleware<
    "permdock",
    WithPermDockConfig | undefined,
    SupabaseMiddlewareContext,
    PermDock<V>
  >;
  readonly permdockHandler: () => SupabaseMiddlewareHandler;
  readonly openapi: OpenApiHooks;
};

const SECRET_KEY_NAME = /^[A-Za-z0-9_-]+$/u;

function secretKeySubjects(
  keys: Readonly<Record<string, SupabaseSecretKey>> | undefined,
  permissions: PermissionTree,
): ReadonlyMap<string, Subject> {
  const subjects = new Map<string, Subject>();
  for (const [name, key] of Object.entries(keys ?? {})) {
    if (!SECRET_KEY_NAME.test(name)) {
      throw new Error(
        `PermDock: secretKeys name '${name}' must be a key name from SUPABASE_SECRET_KEYS, not a pattern`,
      );
    }
    if (key.id === "" || key.tenant === "") {
      throw new Error(
        `PermDock: secretKeys.${name} needs a non-empty id and tenant`,
      );
    }
    const credential: Credential = {
      v: 1,
      id: `supabase-secret:${name}`,
      kind: "service",
      principal: key.id,
      tenant: key.tenant,
      roles: [...key.roles],
      permissions: key.permissions.map((permission) => ({
        permission: permission.key,
      })),
      createdBy: key.id,
      // Declared in code: the key has no creation record.
      createdAt: 0,
      name,
    };
    subjects.set(name, credentialSubject(credential, { permissions }));
  }
  return subjects;
}

function readString(ctx: object, key: string): string | undefined {
  const value: unknown = Reflect.get(ctx, key);
  return typeof value === "string" ? value : undefined;
}

/**
 * `authMode` and `authKeyName` are optional upstream contributions (only
 * `withSupabase` makes them), so they are read here instead of being part of
 * the entry's declared prerequisites.
 */
function secretKeySubject(
  subjects: ReadonlyMap<string, Subject>,
  ctx: SupabaseMiddlewareContext,
): Subject | undefined {
  if (
    subjects.size === 0 ||
    ctx.jwtClaims !== null ||
    readString(ctx, "authMode") !== "secret"
  ) {
    return undefined;
  }
  const name = readString(ctx, "authKeyName");
  return name === undefined ? undefined : subjects.get(name);
}

export function createPermDock<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: SupabaseMiddlewarePermDockOptions<TUser>,
): SupabaseMiddlewarePermDock<V> {
  const contexts = new WeakMap<Request, SupabaseMiddlewareContext>();
  const tenantOption = options.tenant;

  const contextFor = (request: Request): SupabaseMiddlewareContext =>
    contexts.get(request) ?? { jwtClaims: null };
  const secretKeys = secretKeySubjects(options.secretKeys, policy.permissions);

  const kernel = createServerKernel(
    policy,
    compact({
      subject: (request: Request) => {
        const ctx = contextFor(request);
        const service = secretKeySubject(secretKeys, ctx);
        // SAFETY: the kernel passes it to core createPermDock, which accepts TUser, a Subject or null.
        return (service ?? options.subject(ctx, request)) as
          | TUser
          | Promise<TUser>;
      },
      tenant:
        typeof tenantOption === "function"
          ? (
              request: Request,
            ): string | undefined | Promise<string | undefined> =>
              tenantOption(contextFor(request), request)
          : tenantOption,
      ...instanceOptions(options),
      store: options.store,
      pdp: options.pdp,
      webBotAuth: options.webBotAuth,
      adapter: "supabase-middleware",
      wrap: options.otel,
    }),
  );

  const bind = (request: Request, ctx: SupabaseMiddlewareContext): Request => {
    contexts.set(request, ctx);
    return request;
  };

  const withPermDock = defineMiddleware<
    "permdock",
    WithPermDockConfig | undefined,
    SupabaseMiddlewareContext,
    PermDock<V>
  >({
    key: "permdock",
    run:
      (config) =>
      async (
        request,
        ctx,
      ): Promise<Response | { readonly permdock: PermDock<V> }> => {
        bind(request, ctx);
        if (
          config?.protect === undefined &&
          config?.oauthScopes === undefined
        ) {
          const instance = await attached(() => kernel.permdock(request));
          return instance.ok
            ? { permdock: instance.permdock }
            : instance.response;
        }
        const loadData = config.data;
        const guard = await kernel.protect(
          config.protect ?? null,
          loadData === undefined
            ? undefined
            : (): unknown => loadData(ctx, request),
          compact({ trusted: config.trusted, oauthScopes: config.oauthScopes }),
        )(request);
        if (!guard.ok) {
          return guard.response;
        }
        return { permdock: guard.permdock };
      },
  });

  const permdockHandler = (): SupabaseMiddlewareHandler => {
    const { POST, GET } = kernel.permdockHandler();
    return (request, ctx): Promise<Response> => {
      bind(request, ctx);
      switch (request.method) {
        case "POST":
          return POST(request);
        case "GET":
          return GET(request);
        default:
          return Promise.resolve(methodNotAllowed("GET, POST"));
      }
    };
  };

  return { withPermDock, permdockHandler, openapi: kernel.openapi };
}
