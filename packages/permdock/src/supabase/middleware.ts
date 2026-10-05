import { type Middleware, defineMiddleware } from "@supabase/middleware";

import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "../core/instance-options.ts";
import type { SnapshotSource } from "../core/interfaces.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";
import type { Policy, PolicyVocabulary } from "../core/policy.ts";
import type { Principal, Subject } from "../core/subject.ts";
import type { OtelWrap } from "../otel/types.ts";
import type { PdpFactory } from "../pdp/types.ts";
import type { OpenApiHooks } from "../server/create.ts";
import type { WebBotAuthVerifier } from "../server/web-bot-auth.ts";

import { compact } from "../core/compact.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { createKernel } from "../server/create.ts";
import { invalidSignatureResponse } from "../server/web-bot-auth.ts";

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
 * is the anonymous caller (no bearer token, an `sb_*` API key, or the `secret`
 * auth mode).
 */
export type SupabaseMiddlewareContext = {
  readonly jwtClaims: SupabaseJwtClaims | null;
};

export type SupabaseMiddlewarePermDockOptions<TUser = unknown> =
  InstanceOptions & {
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
    readonly store?: ApprovalStore;
    /** `createPermDock` from `permdock/pdp`; `protect` then decides delegated permissions remotely. */
    readonly pdp?: PdpFactory;
    /** @deprecated Not read by any adapter. */
    readonly snapshots?: SnapshotSource;
    /** `(permdock) => withOtel(permdock, options)` from `permdock/otel`. */
    readonly otel?: OtelWrap;
    /** `(request) => verifyWebBotAuth(request, options)`; a verified bot becomes the actor. */
    readonly webBotAuth?: WebBotAuthVerifier;
  };

export type WithPermDockConfig = {
  /** Run `protect` before the handler; a denial short-circuits with Problem Details. */
  readonly protect?: Permission;
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

  const kernel = createKernel(
    policy,
    compact({
      subject: (request: Request) =>
        // SAFETY: the kernel passes it to core createPermDock, which accepts TUser, a Subject or null.
        options.subject(contextFor(request), request) as TUser | Promise<TUser>,
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
        if (config?.protect === undefined) {
          try {
            return { permdock: await kernel.permdock(request) };
          } catch (error) {
            const response = invalidSignatureResponse(error);
            if (response !== undefined) {
              return response;
            }
            throw error;
          }
        }
        const loadData = config.data;
        const guard = await kernel.protect(
          config.protect,
          loadData === undefined
            ? undefined
            : (): unknown => loadData(ctx, request),
          compact({ trusted: config.trusted }),
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
          return Promise.resolve(
            new Response(null, {
              status: 405,
              headers: { Allow: "GET, POST" },
            }),
          );
      }
    };
  };

  return { withPermDock, permdockHandler, openapi: kernel.openapi };
}
