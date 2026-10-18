import type {
  McpServer,
  ResourceTemplate,
  ScopeChallengeHandler,
} from "@modelcontextprotocol/server";

import type { Permission, ToolHints } from "../core/permission-types.ts";
import type {
  GuardedMcpServer,
  McpProcedureEnforcement,
  ProcedureMcpServer,
} from "./types.ts";

import { boundedMap } from "../agent/lru.ts";
import { isRecord } from "../core/compact.ts";
import { challengeScope, scopesReaching } from "../core/oauth-scopes.ts";
import { annotationsFor } from "../core/permission-leaf.ts";
import { type McpChecks, guard, reachOf, visible } from "./call-check.ts";
import {
  type Context,
  type Reach,
  challengeFor,
  contextOf,
  declaredScopes,
  definesCacheScope,
  sessionKey,
} from "./mcp-auth.ts";
import { throwRefusal, toolRefusal } from "./refusals.ts";

const SESSIONS_PER_SERVER = 1000;

export type Handler = (...params: unknown[]) => unknown;

export type Registered = {
  update: (updates: Readonly<Record<string, unknown>>) => void;
};

export type InnerServer = {
  setRequestHandler: (method: string, ...rest: unknown[]) => void;
  removeRequestHandler: (method: string) => void;
  sendToolListChanged?: () => Promise<void>;
  getClientCapabilities?: () => unknown;
  _getRequestHandler?: (method: string) => Handler | undefined;
};

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

export function protectServer(
  checks: McpChecks,
  server: McpServer,
  enforcement?: McpProcedureEnforcement,
): GuardedMcpServer | ProcedureMcpServer {
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
        checks,
        context,
        permissionOf,
        entries.map(keyOf),
        remember ? toolDeclared : undefined,
        remember,
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
    const filter = Object.hasOwn(filters, method) ? filters[method] : undefined;
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
      checks,
      context,
      toolPermission,
      [...tools.keys()],
      toolDeclared,
      true,
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
    tool: () => string,
    permission: Permission,
    reach: Reach,
    load: ((args: unknown) => unknown) | undefined,
    handler: Handler,
    longRunning: boolean,
  ): Handler =>
    guard(
      checks,
      permission,
      load,
      handler,
      (params) => (params.length >= 2 ? [params[0]] : [undefined]),
      toolRefusal,
      { after: announce, longRunning, capabilities, reach, tool },
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
    tool: () => string,
    permission: Permission,
    reach: Reach,
    load: ((args: unknown) => unknown) | undefined,
    handler: Handler,
    longRunning: boolean,
  ): Handler =>
    enforcement === undefined
      ? guardTool(tool, permission, reach, load, handler, longRunning)
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
      rawScopes === undefined ? enforcement?.oauthScopesFor?.(name) : rawScopes,
    );
    const reach = reachOf(checks.policy, permission, declared);
    let current = name;
    const tool = (): string => current;
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
      wrapTool(tool, permission, reach, load, handler, longRunning),
    );
    tools.set(name, permission);
    if (declared !== undefined) {
      toolScopes.set(name, declared);
    }
    guardUpdates(
      registered,
      (callback) =>
        wrapTool(tool, permission, reach, load, callback, longRunning),
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
        checks,
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
          scopesReaching(checks.policy, permission),
          challengeScope(checks.policy, permission),
        ),
      },
      wrap(handler),
    );
    prompts.set(name, permission);
    guardUpdates(registered, wrap);
    return registered;
  };

  // SAFETY: the SDK overloads are generic over schemas; the wrapper forwards the same arguments.
  const originalResource = server.registerResource.bind(server) as unknown as (
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
        checks,
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
          scopesReaching(checks.policy, permission),
          challengeScope(checks.policy, permission),
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
}
