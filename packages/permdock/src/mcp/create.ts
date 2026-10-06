import type {
  McpServer,
  ResourceTemplate,
  ScopeChallenge,
  ScopeChallengeHandler,
} from "@modelcontextprotocol/server";

import type { CheckFailure, ToolBinding } from "../agent/types.ts";
import type { Decision } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission, ToolHints } from "../core/permissions.ts";
import type { Policy } from "../core/policy.ts";
import type {
  AuthorizationDetail,
  Delegation,
  Principal,
} from "../core/subject.ts";
import type { BearerChallenge } from "../server/problem.ts";
import type {
  GuardedMcpServer,
  McpAuthInfo,
  McpPermDock,
  McpPermDockOptions,
  McpProcedureEnforcement,
  ProcedureMcpServer,
} from "./types.ts";

import { createAgentKernel } from "../agent/kernel.ts";
import { boundedMap } from "../agent/lru.ts";
import { clientNameOf } from "../core/clients.ts";
import { compact } from "../core/compact.ts";
import { describe } from "../core/describe.ts";
import { instanceOptions } from "../core/instance-options.ts";
import { mayUse } from "../core/may-use.ts";
import { challengeScope, scopesReaching } from "../core/oauth-scopes.ts";
import { annotationsFor } from "../core/permissions.ts";
import { wireDenials } from "../core/wire-denial.ts";
import {
  bearerChallenge,
  protectedResourceMetadataUrl,
  stepUpOf,
} from "../server/problem.ts";
import { mcpActorKind } from "./subject.ts";

/** `_meta` key on `tools/call`, `resources/read` and `prompts/get` carrying an approval token. */
export const APPROVAL_META_KEY = "dev.permdock/approval";

const SESSIONS_PER_SERVER = 1000;

const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";

/** The first protocol revision whose list results define `ttlMs` and `cacheScope`. */
const CACHEABLE_LISTS_SINCE = "2026-07-28";

type Context = {
  readonly sessionId?: string;
  readonly mcpReq?: {
    readonly _meta?: Readonly<Record<string, unknown>>;
    readonly envelope?: Readonly<Record<string, unknown>>;
    readonly requestState?: () => unknown;
    readonly notify?: (notification: {
      readonly method: string;
    }) => Promise<void>;
  };
  readonly http?: { readonly authInfo?: McpAuthInfo };
};

type Refusal = {
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>>;
  /** An MRTR `input_required` result, returned instead of the refusal. */
  readonly inputRequired?: Readonly<Record<string, unknown>>;
};

type Checked =
  | { readonly ok: true; readonly approved?: string }
  | { readonly ok: false; readonly refusal: Refusal };

/** What a completion re-check still accepts after the handler ran. */
function stillAllowed(
  decision: Decision,
  approved: string | undefined,
): boolean {
  switch (decision.outcome) {
    case "granted":
      return true;
    case "approval-required":
      return approved !== undefined && decision.token === approved;
    case "denied":
      return (
        decision.denials.length > 0 &&
        decision.denials.every((denial) => denial.reason === "limit")
      );
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

type Handler = (...params: unknown[]) => unknown;

type Registered = {
  update: (updates: Readonly<Record<string, unknown>>) => void;
};

type InnerServer = {
  setRequestHandler: (method: string, ...rest: unknown[]) => void;
  removeRequestHandler: (method: string) => void;
  sendToolListChanged?: () => Promise<void>;
  getClientCapabilities?: () => unknown;
  _getRequestHandler?: (method: string) => Handler | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contextOf(value: unknown): Context {
  // SAFETY: a record from the SDK's handler context; every Context field is optional and type-checked on read.
  return isRecord(value) ? (value as Context) : {};
}

function approvalTokenOf(context: Context): string | undefined {
  let fromState: unknown;
  try {
    fromState = context.mcpReq?.requestState?.();
  } catch {
    fromState = undefined;
  }
  if (typeof fromState === "string" && fromState !== "") {
    return fromState;
  }
  // oxlint-disable-next-line no-underscore-dangle -- the MCP protocol names it `_meta`
  const fromMeta = context.mcpReq?._meta?.[APPROVAL_META_KEY];
  if (typeof fromMeta === "string" && fromMeta !== "") {
    return fromMeta;
  }
  const fromAuth = context.http?.authInfo?.extra?.["approval"];
  return typeof fromAuth === "string" && fromAuth !== "" ? fromAuth : undefined;
}

function authorizationDetailsOf(
  authInfo: McpAuthInfo,
): readonly AuthorizationDetail[] | undefined {
  const details =
    authInfo.extra?.["authorizationDetails"] ??
    authInfo.extra?.["authorization_details"];
  // SAFETY: authInfo comes from the server's token verifier, which puts RFC 9396 entries in this array.
  return Array.isArray(details)
    ? (details as readonly AuthorizationDetail[])
    : undefined;
}

function delegationOf(authInfo: McpAuthInfo): Delegation | undefined {
  return compact<Delegation>({
    scopes: authInfo.scopes,
    authorizationDetails: authorizationDetailsOf(authInfo),
  });
}

function hasScope(authInfo: McpAuthInfo, scopes: readonly string[]): boolean {
  return scopes.some((scope) => (authInfo.scopes ?? []).includes(scope));
}

function resourceMetadataOf(authInfo: McpAuthInfo): string | undefined {
  if (authInfo.resourceMetadataUrl !== undefined) {
    return authInfo.resourceMetadataUrl;
  }
  const resource = authInfo.resource;
  return resource?.protocol === "https:" || resource?.protocol === "http:"
    ? protectedResourceMetadataUrl(resource)
    : undefined;
}

function sameResource(
  expected: string | URL,
  actual: URL | undefined,
): boolean {
  if (actual === undefined) {
    return false;
  }
  try {
    return new URL(String(expected)).href === new URL(String(actual)).href;
  } catch {
    return false;
  }
}

/**
 * Whether the request was sent under a revision that defines `cacheScope` on
 * list results. Only those requests carry the per-request envelope; a
 * 2025-era request has none and gets no cache fields.
 */
function definesCacheScope(context: Context): boolean {
  const version = context.mcpReq?.envelope?.[PROTOCOL_VERSION];
  return typeof version === "string" && version >= CACHEABLE_LISTS_SINCE;
}

function acceptsUrlElicitation(
  context: Context,
  fallback: (() => unknown) | undefined,
): boolean {
  const fromEnvelope = context.mcpReq?.envelope?.[CLIENT_CAPABILITIES];
  const capabilities = isRecord(fromEnvelope) ? fromEnvelope : fallback?.();
  if (!isRecord(capabilities) || !isRecord(capabilities["elicitation"])) {
    return false;
  }
  return isRecord(capabilities["elicitation"]["url"]);
}

function withParams(
  at: string,
  params: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let url: URL;
  try {
    url = new URL(at);
  } catch {
    return undefined;
  }
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url.href;
}

function urlElicitation(
  key: string,
  message: string,
  url: string,
  requestState: string | undefined,
): Readonly<Record<string, unknown>> {
  return compact({
    resultType: "input_required",
    inputRequests: {
      [key]: {
        method: "elicitation/create",
        params: { mode: "url", message, url },
      },
    },
    requestState,
  });
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  if (isRecord(data)) {
    const id = data["id"];
    if (typeof id === "string" || typeof id === "number") {
      return { type: permission.resource, id: String(id) };
    }
  }
  return { type: permission.resource };
}

function deniedRefusal(
  decision: Extract<Decision, { readonly outcome: "denied" }>,
  permission: Permission,
  data: unknown,
): Refusal {
  const alternatives = decision.alternatives.map((leaf) => leaf.key);
  const resource = resourceRef(permission, data);
  const suffix =
    resource.id === undefined
      ? permission.key
      : `${permission.key} on ${resource.id}`;
  const maybe =
    alternatives.length === 0 ? "" : ` You may: ${alternatives.join(", ")}.`;
  return {
    text: `Denied: ${suffix}.${maybe}`,
    structured: {
      outcome: "denied",
      permission: permission.key,
      resource,
      denials: wireDenials(decision.denials),
      alternatives,
      detail: describe(decision).detail,
    },
  };
}

function approvalRefusal(
  decision: Extract<Decision, { readonly outcome: "approval-required" }>,
  permission: Permission,
  data: unknown,
): Refusal {
  return {
    text: describe(decision).detail,
    structured: {
      outcome: "approval-required",
      permission: permission.key,
      resource: resourceRef(permission, data),
      token: decision.token,
    },
  };
}

function plainRefusal(
  permission: Permission,
  text: string,
  extra: Readonly<Record<string, unknown>>,
): Refusal {
  return {
    text,
    structured: {
      outcome: "denied",
      permission: permission.key,
      resource: { type: permission.resource },
      alternatives: [],
      ...extra,
    },
  };
}

function tenantOf(
  tenant: McpPermDockOptions["tenant"],
):
  | string
  | ((call: McpCall) => ReturnType<Exclude<typeof tenant, string | undefined>>)
  | undefined {
  if (typeof tenant !== "function") {
    return tenant;
  }
  return (call) => tenant(call.authInfo ?? {});
}

/** What the kernel sees of one MCP request; built per call so no two share an instance. */
type McpCall = { readonly authInfo?: McpAuthInfo };

type Reach = {
  readonly scopes: readonly string[];
  readonly challenge: string;
};

function failedRefusal(permission: Permission, failure: CheckFailure): Refusal {
  switch (failure) {
    case "load-failed":
      return plainRefusal(
        permission,
        `Denied: ${permission.key} failed closed.`,
        {
          denials: [{ role: null, reason: "validation" }],
        },
      );
    case "no-data":
      return plainRefusal(
        permission,
        `Denied: ${permission.key} found nothing to decide on.`,
        { denials: [{ role: null, reason: "validation" }] },
      );
    case "failed":
      return plainRefusal(
        permission,
        `Denied: ${permission.key} failed closed.`,
        {},
      );
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function toolRefusal(refusal: Refusal): unknown {
  if (refusal.inputRequired !== undefined) {
    return refusal.inputRequired;
  }
  return {
    isError: true,
    content: [{ type: "text", text: refusal.text }],
    structuredContent: refusal.structured,
  };
}

function requirePermission(
  kind: string,
  name: string,
  config: unknown,
): Permission {
  const permission = isRecord(config) ? config["permission"] : undefined;
  if (!isRecord(permission) || typeof permission["key"] !== "string") {
    throw new TypeError(
      `permdock/mcp: ${kind} ${name} has no permission; every guarded registration needs one.`,
    );
  }
  // SAFETY: checked above to be a record with a string key; decisions identify permissions by key.
  return permission as unknown as Permission;
}

function sessionKey(context: Context): string {
  return context.sessionId ?? "";
}

function throwRefusal(refusal: Refusal): unknown {
  if (refusal.inputRequired !== undefined) {
    return refusal.inputRequired;
  }
  throw new Error(refusal.text);
}

function declaredScopes(
  name: string,
  value: unknown,
): readonly [string, ...string[]] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const scopes: unknown[] = Array.isArray(value) ? value : [];
  const names = scopes.filter(
    (scope): scope is string => typeof scope === "string" && scope !== "",
  );
  const [first, ...rest] = names;
  if (first === undefined || names.length !== scopes.length) {
    throw new TypeError(
      `permdock/mcp: tool ${name} sets oauthScopes, which must be a non-empty list of scope names.`,
    );
  }
  return Object.freeze([first, ...rest]);
}

function challengeFor(
  own: ScopeChallengeHandler | undefined,
  reaching: readonly string[],
  challenged: string,
): ScopeChallengeHandler {
  return async (context) => {
    const first = await own?.(context);
    if (first !== undefined) {
      return first;
    }
    const authInfo = context.authInfo;
    if (authInfo === undefined || hasScope(authInfo, reaching)) {
      return undefined;
    }
    return { scopes: [challenged] } satisfies ScopeChallenge;
  };
}

function guardUpdates(
  registered: Registered,
  wrap: (callback: Handler) => Handler,
  rename?: (from: string, to: string | null) => void,
  currentName?: () => string,
): void {
  const update = registered.update.bind(registered);
  registered.update = (updates): void => {
    const next: Record<string, unknown> = { ...updates };
    if (typeof updates["callback"] === "function") {
      // SAFETY: the typeof check above confirms a function; Handler takes any arguments.
      next["callback"] = wrap(updates["callback"] as Handler);
    }
    if (rename !== undefined && currentName !== undefined) {
      const to = updates["name"];
      if (typeof to === "string" || to === null) {
        rename(currentName(), to);
      }
    }
    update(next);
  };
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: McpPermDockOptions<TUser>,
): McpPermDock {
  const actorKind = mcpActorKind(options.actorKind);
  if (actorKind === undefined) {
    throw new TypeError("permdock/mcp: actorKind must be a non-empty string");
  }
  const kernel = createAgentKernel<McpCall, TUser>(
    // SAFETY: the kernel reads the principal only through the policy's own subject function.
    policy as Policy<TUser>,
    compact({
      subject: (call: McpCall) => options.subject(call.authInfo ?? {}),
      actor: (call: McpCall) => {
        const clientId = call.authInfo?.clientId;
        return typeof clientId === "string" && clientId !== ""
          ? compact({
              id: clientId,
              kind: actorKind,
              client: clientNameOf(options.clients, clientId),
            })
          : undefined;
      },
      delegation: (call: McpCall) =>
        call.authInfo === undefined ? undefined : delegationOf(call.authInfo),
      tenant: tenantOf(options.tenant),
      store: options.store,
      adapter: "mcp",
      boundary: "mcp-args" as const,
      wrap: options.otel,
      ...instanceOptions(options),
    }),
  );

  const forThisServer = (authInfo: McpAuthInfo): boolean =>
    options.resource === undefined ||
    sameResource(options.resource, authInfo.resource);

  const reachOf = (
    permission: Permission,
    declared: readonly [string, ...string[]] | undefined,
  ): Reach =>
    declared === undefined
      ? {
          scopes: scopesReaching(policy, permission),
          challenge: challengeScope(policy, permission),
        }
      : { scopes: declared, challenge: declared[0] };

  const reachable = (
    authInfo: McpAuthInfo | undefined,
    reach: Reach,
  ): boolean =>
    authInfo === undefined
      ? options.requireAuthInfo !== true
      : forThisServer(authInfo) && hasScope(authInfo, reach.scopes);

  const approvalInput = async (
    decision: Extract<Decision, { readonly outcome: "approval-required" }>,
    handlerContext: unknown,
    context: Context,
    capabilities: (() => unknown) | undefined,
  ): Promise<Readonly<Record<string, unknown>> | undefined> => {
    const at = options.approval?.at;
    if (at === undefined || !acceptsUrlElicitation(context, capabilities)) {
      return undefined;
    }
    const url = withParams(at, { token: decision.token });
    if (url === undefined) {
      return undefined;
    }
    // SAFETY: handlerContext is the SDK handler context, passed unchanged to the SDK's own codec.
    const requestState =
      options.requestState === undefined
        ? decision.token
        : await options.requestState.mint(
            decision.token,
            handlerContext as never,
          );
    return urlElicitation(
      "approval",
      options.approval?.hint ?? describe(decision).detail,
      url,
      requestState,
    );
  };

  const stepUpRefusal = (
    decision: Extract<Decision, { readonly outcome: "denied" }>,
    permission: Permission,
    data: unknown,
    context: Context,
    capabilities: (() => unknown) | undefined,
  ): Refusal => {
    const base = deniedRefusal(decision, permission, data);
    const { acrValues, maxAge } = stepUpOf(decision);
    const at = options.stepUp?.at;
    const url =
      at === undefined || !acceptsUrlElicitation(context, capabilities)
        ? undefined
        : withParams(at, {
            acr_values: acrValues?.join(" "),
            max_age: maxAge === undefined ? undefined : String(maxAge),
          });
    return compact<Refusal>({
      text: base.text,
      structured: compact({
        ...base.structured,
        error: "insufficient_user_authentication",
        acr_values: acrValues?.join(" "),
        max_age: maxAge,
        www_authenticate: bearerChallenge(
          compact<BearerChallenge>({
            error: "insufficient_user_authentication",
            acrValues,
            maxAge,
          }),
        ),
      }),
      inputRequired:
        url === undefined
          ? undefined
          : urlElicitation(
              "step_up",
              `Sign in again to use ${permission.key}.`,
              url,
              undefined,
            ),
    });
  };

  const check = async (
    permission: Permission,
    reach: Reach,
    load: (() => unknown) | undefined,
    context: Context,
    handlerContext: unknown,
    capabilities: (() => unknown) | undefined,
    completion?: { readonly approved: string | undefined },
  ): Promise<Checked> => {
    const authInfo = context.http?.authInfo;
    if (authInfo === undefined && options.requireAuthInfo === true) {
      return {
        ok: false,
        refusal: plainRefusal(permission, "Denied: no verified credentials.", {
          error: "invalid_token",
        }),
      };
    }
    if (authInfo !== undefined && !forThisServer(authInfo)) {
      return {
        ok: false,
        refusal: plainRefusal(
          permission,
          "Denied: the token was not issued for this server.",
          { error: "invalid_token" },
        ),
      };
    }
    if (authInfo !== undefined && !hasScope(authInfo, reach.scopes)) {
      const resourceMetadata = resourceMetadataOf(authInfo);
      const challenged = reach.challenge;
      return {
        ok: false,
        refusal: plainRefusal(
          permission,
          `Denied: ${permission.key} needs the ${challenged} scope.`,
          compact({
            error: "insufficient_scope",
            scope: challenged,
            resource_metadata: resourceMetadata,
            www_authenticate: bearerChallenge(
              compact({
                error: "insufficient_scope" as const,
                scopes: [challenged],
                resourceMetadata,
              }),
            ),
          }),
        ),
      };
    }
    const binding = compact<ToolBinding>({
      permission,
      data: load === undefined ? undefined : (): unknown => load(),
    });
    const call: McpCall = compact({ authInfo });
    if (completion !== undefined) {
      const rechecked = await kernel.check(binding, undefined, call, {
        simulate: true,
      });
      if (!rechecked.ok) {
        return {
          ok: false,
          refusal: failedRefusal(permission, rechecked.failure),
        };
      }
      if (stillAllowed(rechecked.raw, completion.approved)) {
        return { ok: true };
      }
      return {
        ok: false,
        refusal:
          rechecked.raw.outcome === "denied"
            ? deniedRefusal(rechecked.raw, permission, rechecked.data)
            : plainRefusal(
                permission,
                `Denied: ${permission.key} was revoked before the call completed.`,
                {},
              ),
      };
    }
    const checked = await kernel.check(
      binding,
      undefined,
      call,
      compact({ resumeToken: approvalTokenOf(context) }),
    );
    if (!checked.ok) {
      return { ok: false, refusal: failedRefusal(permission, checked.failure) };
    }
    const { raw, decision, data } = checked;
    switch (decision.outcome) {
      case "granted":
        return raw.outcome === "approval-required"
          ? { ok: true, approved: raw.token }
          : { ok: true };
      case "denied":
        return {
          ok: false,
          refusal: decision.denials.some(
            (denial) => denial.reason === "insufficient-user-authentication",
          )
            ? stepUpRefusal(decision, permission, data, context, capabilities)
            : deniedRefusal(decision, permission, data),
        };
      case "approval-required":
        try {
          return {
            ok: false,
            refusal: compact<Refusal>({
              ...approvalRefusal(decision, permission, data),
              inputRequired: await approvalInput(
                decision,
                handlerContext,
                context,
                capabilities,
              ),
            }),
          };
        } catch {
          return { ok: false, refusal: failedRefusal(permission, "failed") };
        }
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  };

  const visible = async (
    context: Context,
    permissionOf: (key: string) => Permission | undefined,
    keys: readonly string[],
    declaredOf: (
      key: string,
    ) => readonly [string, ...string[]] | undefined = () => undefined,
  ): Promise<ReadonlySet<string>> => {
    const authInfo = context.http?.authInfo;
    const shown = new Set<string>();
    const guarded: {
      readonly key: string;
      readonly permission: Permission;
    }[] = [];
    for (const key of keys) {
      const permission = permissionOf(key);
      if (permission === undefined) {
        shown.add(key);
      } else if (reachable(authInfo, reachOf(permission, declaredOf(key)))) {
        guarded.push({ key, permission });
      }
    }
    if (guarded.length === 0) {
      return shown;
    }
    let permdock: PermDock;
    try {
      permdock = await kernel.instance(compact({ authInfo }));
    } catch {
      // A subject that cannot be built sees no guarded entry.
      return shown;
    }
    for (const entry of guarded) {
      if (mayUse(permdock, entry.permission)) {
        shown.add(entry.key);
      }
    }
    return shown;
  };

  const guard =
    (
      permission: Permission,
      load: ((...args: unknown[]) => unknown) | undefined,
      handler: Handler,
      dataArgs: (params: readonly unknown[]) => readonly unknown[],
      onRefusal: (refusal: Refusal) => unknown,
      extra: {
        readonly after?: (context: Context) => Promise<void>;
        readonly longRunning?: boolean;
        readonly capabilities?: () => unknown;
        readonly reach?: Reach;
      } = {},
    ): Handler =>
    async (...params: unknown[]): Promise<unknown> => {
      const raw = params.at(-1);
      const context = contextOf(raw);
      const loader =
        load === undefined
          ? undefined
          : (): unknown => load(...dataArgs(params));
      const reach = extra.reach ?? reachOf(permission, undefined);
      const checked = await check(
        permission,
        reach,
        loader,
        context,
        raw,
        extra.capabilities,
      );
      let result: unknown;
      if (checked.ok) {
        result = await handler(...params);
        if (extra.longRunning === true) {
          const again = await check(
            permission,
            reach,
            loader,
            context,
            raw,
            extra.capabilities,
            { approved: checked.approved },
          );
          if (!again.ok) {
            result = onRefusal(again.refusal);
          }
        }
      } else {
        result = onRefusal(checked.refusal);
      }
      await extra.after?.(context);
      return result;
    };

  const protectServer = (
    server: McpServer,
    enforcement?: McpProcedureEnforcement,
  ): GuardedMcpServer | ProcedureMcpServer => {
    const tools = new Map<string, Permission>();
    const toolScopes = new Map<string, readonly [string, ...string[]]>();
    const prompts = new Map<string, Permission>();
    const resources = new Map<string, Permission>();
    const templates: {
      readonly template: ResourceTemplate;
      readonly permission: Permission;
    }[] = [];
    const lastListed = boundedMap<string, string>(SESSIONS_PER_SERVER);

    const toolPermission = (name: string): Permission | undefined =>
      tools.get(name);
    const toolDeclared = (
      name: string,
    ): readonly [string, ...string[]] | undefined => toolScopes.get(name);
    const promptPermission = (name: string): Permission | undefined =>
      prompts.get(name);
    const resourcePermission = (uri: string): Permission | undefined => {
      const direct = resources.get(uri);
      if (direct !== undefined) {
        return direct;
      }
      return templates.find(
        (entry) => entry.template.uriTemplate.match(uri) !== null,
      )?.permission;
    };
    const templatePermission = (uriTemplate: string): Permission | undefined =>
      templates.find(
        (entry) => entry.template.uriTemplate.toString() === uriTemplate,
      )?.permission;

    const listFilter =
      <TEntry extends Readonly<Record<string, unknown>>>(
        field: string,
        keyOf: (entry: TEntry) => string,
        permissionOf: (key: string) => Permission | undefined,
        remember: boolean,
      ) =>
      async (result: unknown, rawContext: unknown): Promise<unknown> => {
        if (!isRecord(result) || !Array.isArray(result[field])) {
          return result;
        }
        const context = contextOf(rawContext);
        // SAFETY: checked to be an array above; the SDK's list result schema gives each entry TEntry's key.
        const entries = result[field] as TEntry[];
        const shown = await visible(
          context,
          permissionOf,
          entries.map(keyOf),
          remember ? toolDeclared : undefined,
        );
        const kept = entries.filter((entry) => shown.has(keyOf(entry)));
        if (remember) {
          lastListed.set(sessionKey(context), [...shown].toSorted().join(","));
        }
        return definesCacheScope(context)
          ? { ...result, [field]: kept, cacheScope: "private" }
          : { ...result, [field]: kept };
      };

    const filters: Readonly<
      Record<string, (result: unknown, context: unknown) => Promise<unknown>>
    > = {
      "tools/list": listFilter<{ readonly name: string }>(
        "tools",
        (entry) => entry.name,
        toolPermission,
        true,
      ),
      "prompts/list": listFilter<{ readonly name: string }>(
        "prompts",
        (entry) => entry.name,
        promptPermission,
        false,
      ),
      "resources/list": listFilter<{ readonly uri: string }>(
        "resources",
        (entry) => entry.uri,
        resourcePermission,
        false,
      ),
      "resources/templates/list": listFilter<{ readonly uriTemplate: string }>(
        "resourceTemplates",
        (entry) => entry.uriTemplate,
        templatePermission,
        false,
      ),
    };

    // SAFETY: server.server is the SDK's low-level Server; InnerServer names the methods used here.
    const inner = server.server as unknown as InnerServer;
    const capabilities = (): unknown => inner.getClientCapabilities?.();
    const set = inner.setRequestHandler.bind(inner);
    inner.setRequestHandler = (method: string, ...rest: unknown[]): void => {
      const filter = Object.hasOwn(filters, method)
        ? filters[method]
        : undefined;
      const [handler] = rest;
      if (
        filter !== undefined &&
        rest.length === 1 &&
        typeof handler === "function"
      ) {
        set(method, async (request: unknown, context: unknown) =>
          // SAFETY: the typeof check above confirms a function; Handler takes any arguments.
          filter(await (handler as Handler)(request, context), context),
        );
        return;
      }
      set(method, ...rest);
    };
    for (const method of Object.keys(filters)) {
      // oxlint-disable-next-line no-underscore-dangle -- the SDK's own accessor for installed handlers
      const existing = inner._getRequestHandler?.(method);
      if (existing !== undefined) {
        inner.removeRequestHandler(method);
        inner.setRequestHandler(method, (request: unknown, context: unknown) =>
          existing(request, context),
        );
      }
    }

    const announce = async (context: Context): Promise<void> => {
      const key = sessionKey(context);
      const before = lastListed.get(key);
      if (before === undefined) {
        return;
      }
      const shown = await visible(
        context,
        toolPermission,
        [...tools.keys()],
        toolDeclared,
      );
      const after = [...shown].toSorted().join(",");
      if (after === before) {
        return;
      }
      lastListed.set(key, after);
      try {
        await (context.mcpReq?.notify?.({
          method: "notifications/tools/list_changed",
        }) ?? inner.sendToolListChanged?.());
      } catch {
        // A lost notification only delays the client's next list.
      }
    };

    const guardTool = (
      permission: Permission,
      reach: Reach,
      load: ((args: unknown) => unknown) | undefined,
      handler: Handler,
      longRunning: boolean,
    ): Handler =>
      guard(
        permission,
        load,
        handler,
        (params) => (params.length >= 2 ? [params[0]] : [undefined]),
        toolRefusal,
        { after: announce, longRunning, capabilities, reach },
      );

    // SAFETY: the SDK overloads are generic over schemas; the wrapper forwards the same arguments.
    // oxlint-disable-next-line typescript/no-deprecated -- bind() resolves to the raw-shape overload
    const originalTool = server.registerTool.bind(server) as unknown as (
      name: string,
      config: Readonly<Record<string, unknown>>,
      handler: Handler,
    ) => Registered;
    const toolPermissionOf = (
      name: string,
      config: Readonly<Record<string, unknown>>,
    ): Permission => {
      if (enforcement === undefined || config["permission"] !== undefined) {
        return requirePermission("tool", name, config);
      }
      for (const field of ["data", "longRunning"]) {
        if (config[field] !== undefined) {
          throw new TypeError(
            `permdock/mcp: tool ${name} sets ${field}, but with enforce: 'procedure' its procedure decides.`,
          );
        }
      }
      return requirePermission("tool", name, {
        permission: enforcement.permissionFor(name),
      });
    };
    /** With `enforce: 'procedure'` the handler runs undecided: the procedure it calls decides. */
    const wrapTool = (
      permission: Permission,
      reach: Reach,
      load: ((args: unknown) => unknown) | undefined,
      handler: Handler,
      longRunning: boolean,
    ): Handler =>
      enforcement === undefined
        ? guardTool(permission, reach, load, handler, longRunning)
        : async (...params: unknown[]): Promise<unknown> => {
            const result: unknown = await handler(...params);
            await announce(contextOf(params.at(-1)));
            return result;
          };
    const registerTool = (
      name: string,
      config: Readonly<Record<string, unknown>>,
      handler: Handler,
    ): Registered => {
      const permission = toolPermissionOf(name, config);
      const {
        permission: _permission,
        data,
        scopeChallenge,
        longRunning: rawLongRunning,
        oauthScopes: rawScopes,
        ...passthrough
      } = config;
      // SAFETY: GuardedMcpServer types a tool config's data as a loader over the tool args.
      const load = data as ((args: unknown) => unknown) | undefined;
      const longRunning = rawLongRunning === true;
      const declared = declaredScopes(
        name,
        rawScopes === undefined
          ? enforcement?.oauthScopesFor?.(name)
          : rawScopes,
      );
      const reach = reachOf(permission, declared);
      // SAFETY: GuardedMcpServer types annotations as ToolHints and scopeChallenge as its handler.
      const registered = originalTool(
        name,
        {
          ...passthrough,
          annotations: {
            ...annotationsFor(permission),
            ...(passthrough["annotations"] as ToolHints | undefined),
          },
          scopeChallenge: challengeFor(
            scopeChallenge as ScopeChallengeHandler | undefined,
            reach.scopes,
            reach.challenge,
          ),
        },
        wrapTool(permission, reach, load, handler, longRunning),
      );
      tools.set(name, permission);
      if (declared !== undefined) {
        toolScopes.set(name, declared);
      }
      let current = name;
      guardUpdates(
        registered,
        (callback) => wrapTool(permission, reach, load, callback, longRunning),
        (from, to) => {
          tools.delete(from);
          toolScopes.delete(from);
          if (to !== null) {
            tools.set(to, permission);
            if (declared !== undefined) {
              toolScopes.set(to, declared);
            }
            current = to;
          }
        },
        () => current,
      );
      return registered;
    };

    // SAFETY: the SDK overloads are generic over schemas; the wrapper forwards the same arguments.
    // oxlint-disable-next-line typescript/no-deprecated -- bind() resolves to the raw-shape overload
    const originalPrompt = server.registerPrompt.bind(server) as unknown as (
      name: string,
      config: Readonly<Record<string, unknown>>,
      handler: Handler,
    ) => Registered;
    const registerPrompt = (
      name: string,
      config: Readonly<Record<string, unknown>>,
      handler: Handler,
    ): Registered => {
      const permission = requirePermission("prompt", name, config);
      const {
        permission: _permission,
        data,
        scopeChallenge,
        ...passthrough
      } = config;
      // SAFETY: GuardedMcpServer types a prompt config's data as a loader over the prompt args.
      const load = data as ((...args: unknown[]) => unknown) | undefined;
      const wrap = (callback: Handler): Handler =>
        guard(
          permission,
          load,
          callback,
          (params) => (params.length >= 2 ? [params[0]] : [undefined]),
          throwRefusal,
          { capabilities },
        );
      // SAFETY: GuardedMcpServer types a prompt config's scopeChallenge as ScopeChallengeHandler.
      const registered = originalPrompt(
        name,
        {
          ...passthrough,
          scopeChallenge: challengeFor(
            scopeChallenge as ScopeChallengeHandler | undefined,
            scopesReaching(policy, permission),
            challengeScope(policy, permission),
          ),
        },
        wrap(handler),
      );
      prompts.set(name, permission);
      guardUpdates(registered, wrap);
      return registered;
    };

    // SAFETY: the SDK overloads are generic over schemas; the wrapper forwards the same arguments.
    const originalResource = server.registerResource.bind(
      server,
    ) as unknown as (
      name: string,
      uriOrTemplate: unknown,
      config: Readonly<Record<string, unknown>>,
      read: Handler,
    ) => Registered;
    const registerResource = (
      name: string,
      uriOrTemplate: string | ResourceTemplate,
      config: Readonly<Record<string, unknown>>,
      read: Handler,
    ): Registered => {
      const permission = requirePermission("resource", name, config);
      const {
        permission: _permission,
        data,
        scopeChallenge,
        ...passthrough
      } = config;
      // SAFETY: GuardedMcpServer types a resource config's data as a loader over the read args.
      const load = data as ((...args: unknown[]) => unknown) | undefined;
      const wrap = (callback: Handler): Handler =>
        guard(
          permission,
          load,
          callback,
          (params) => params.slice(0, -1),
          throwRefusal,
          { capabilities },
        );
      // SAFETY: GuardedMcpServer types a resource config's scopeChallenge as ScopeChallengeHandler.
      const registered = originalResource(
        name,
        uriOrTemplate,
        {
          ...passthrough,
          scopeChallenge: challengeFor(
            scopeChallenge as ScopeChallengeHandler | undefined,
            scopesReaching(policy, permission),
            challengeScope(policy, permission),
          ),
        },
        wrap(read),
      );
      if (typeof uriOrTemplate === "string") {
        resources.set(uriOrTemplate, permission);
      } else {
        templates.push({ template: uriOrTemplate, permission });
      }
      guardUpdates(registered, wrap);
      return registered;
    };

    // SAFETY: the server is an object whose three register methods are replaced below.
    const guarded = server as unknown as Record<string, unknown>;
    guarded["registerTool"] = registerTool;
    guarded["registerPrompt"] = registerPrompt;
    guarded["registerResource"] = registerResource;
    // SAFETY: the register methods were just replaced by the guarded ones GuardedMcpServer declares.
    return server as unknown as GuardedMcpServer;
  };

  // SAFETY: the implementation returns ProcedureMcpServer exactly when given McpProcedureEnforcement.
  return { protectServer: protectServer as McpPermDock["protectServer"] };
}
