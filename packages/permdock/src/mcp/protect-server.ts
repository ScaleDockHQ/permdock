import type {
  McpServer,
  ResourceTemplate,
  ScopeChallengeHandler,
} from "@modelcontextprotocol/server";

import type { Permission, ToolHints } from "../core/permission-types.ts";
import type { Access, McpChecks } from "./call-check.ts";
import type { Context, Reach } from "./mcp-auth.ts";
import type {
  GuardedMcpServer,
  McpProcedureEnforcement,
  ProcedureMcpServer,
} from "./types.ts";

import { boundedMap } from "../agent/lru.ts";
import { compact, isRecord } from "../core/compact.ts";
import { challengeScope, scopesReaching } from "../core/oauth-scopes.ts";
import { annotationsFor } from "../core/permission-leaf.ts";
import { guard, guardSet, reachOf, single, visible } from "./call-check.ts";
import {
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

/**
 * A tool's access from its `permission`: `null` for a public tool, else one
 * permission or a non-empty list. Anything else throws, so a tool is public
 * only when it says so.
 */
function toolAccess(
  name: string,
  permission: unknown,
  anyOf: boolean,
): Access | null {
  if (permission === null) {
    return null;
  }
  if (Array.isArray(permission)) {
    if (permission.length === 0) {
      throw new TypeError(
        `permdock/mcp: tool ${name} has an empty permission list.`,
      );
    }
    return {
      permissions: permission.map((entry: unknown) =>
        requirePermission("tool", name, { permission: entry }),
      ),
      anyOf,
    };
  }
  return {
    permissions: [requirePermission("tool", name, { permission })],
    anyOf: false,
  };
}

/** Annotations every permission of an all-of or any-of list agrees on. */
function annotationsOf(access: Access): ToolHints {
  const [only, ...rest] = access.permissions;
  if (only !== undefined && rest.length === 0) {
    return annotationsFor(only);
  }
  const hints = access.permissions.map(annotationsFor);
  const readOnly = hints.every((hint) => hint.readOnlyHint === true);
  return {
    readOnlyHint: readOnly,
    ...(!readOnly && hints.some((hint) => hint.destructiveHint === true)
      ? { destructiveHint: true }
      : {}),
    ...(hints.every((hint) => hint.idempotentHint === true)
      ? { idempotentHint: true }
      : {}),
  };
}

const UI_SCHEME = "ui://";

/** A tool handler takes `(args, ctx)`, or only `ctx` without an input schema. */
function toolArgs(params: readonly unknown[]): readonly unknown[] {
  return params.length >= 2 ? [params[0]] : [undefined];
}

/** The MCP Apps view a tool links through `_meta.ui.resourceUri`. */
function uiResourceUri(meta: unknown): string | undefined {
  const ui = isRecord(meta) ? meta["ui"] : undefined;
  const uri = isRecord(ui) ? ui["resourceUri"] : undefined;
  return typeof uri === "string" && uri.startsWith(UI_SCHEME) ? uri : undefined;
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
  const tools = new Map<string, Access | null>();
  const toolScopes = new Map<string, readonly [string, ...string[]]>();
  const prompts = new Map<string, Permission>();
  const resources = new Map<string, Permission>();
  const views = new Set<string>();
  const uiLinks = new Map<
    string,
    { readonly tool: string; readonly permission: Permission }
  >();
  const templates: {
    readonly template: ResourceTemplate;
    readonly permission: Permission;
  }[] = [];
  const lastListed = boundedMap<string, string>(SESSIONS_PER_SERVER);

  const toolAccessOf = (name: string): Access | undefined =>
    tools.get(name) ?? undefined;
  const toolDeclared = (
    name: string,
  ): readonly [string, ...string[]] | undefined => toolScopes.get(name);
  const promptPermission = (name: string): Permission | undefined =>
    prompts.get(name);
  const resourcePermission = (uri: string): Permission | undefined => {
    const direct = resources.get(uri) ?? uiLinks.get(uri)?.permission;
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
      accessOf: (key: string) => Access | undefined,
      remember: boolean,
      hidden: (key: string) => boolean = (): boolean => false,
    ) =>
    async (result: unknown, rawContext: unknown): Promise<unknown> => {
      if (!isRecord(result) || !Array.isArray(result[field])) {
        return result;
      }
      const context = contextOf(rawContext);
      // SAFETY: checked to be an array above; the SDK's list result schema gives each entry TEntry's key.
      const entries = (result[field] as TEntry[]).filter(
        (entry) => !hidden(keyOf(entry)),
      );
      const shown = await visible(
        checks,
        context,
        accessOf,
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
      toolAccessOf,
      true,
    ),
    "prompts/list": listFilter<{ readonly name: string }>(
      "prompts",
      (entry) => entry.name,
      (name) => single(promptPermission(name)),
      false,
    ),
    "resources/list": listFilter<{ readonly uri: string }>(
      "resources",
      (entry) => entry.uri,
      (uri) => single(resourcePermission(uri)),
      false,
      (uri) => views.has(uri) && resourcePermission(uri) === undefined,
    ),
    "resources/templates/list": listFilter<{ readonly uriTemplate: string }>(
      "resourceTemplates",
      (entry) => entry.uriTemplate,
      (uriTemplate) => single(templatePermission(uriTemplate)),
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
      toolAccessOf,
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

  type ToolLoaders = {
    readonly data: ((args: unknown) => unknown) | undefined;
    readonly rows: ((args: unknown) => unknown) | undefined;
  };

  const guardTool = (
    tool: () => string,
    access: Access,
    reach: Reach,
    declared: readonly [string, ...string[]] | undefined,
    loaders: ToolLoaders,
    handler: Handler,
    longRunning: boolean,
  ): Handler => {
    const [only, ...rest] = access.permissions;
    const extra = { after: announce, capabilities, tool, name: tool };
    if (only !== undefined && rest.length === 0 && loaders.rows === undefined) {
      return guard(checks, only, loaders.data, handler, toolArgs, toolRefusal, {
        ...extra,
        longRunning,
        reach,
      });
    }
    return guardSet(checks, access, loaders, handler, toolArgs, toolRefusal, {
      ...extra,
      declared,
    });
  };

  // SAFETY: the SDK overloads are generic over schemas; the wrapper forwards the same arguments.
  // oxlint-disable-next-line typescript/no-deprecated -- bind() resolves to the raw-shape overload
  const originalTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Readonly<Record<string, unknown>>,
    handler: Handler,
  ) => Registered;
  const toolAccessFor = (
    name: string,
    config: Readonly<Record<string, unknown>>,
  ): Access | null => {
    const fields = ["data", "rows", "longRunning", "anyOf"] as const;
    if (enforcement !== undefined) {
      for (const field of fields) {
        if (config[field] !== undefined) {
          throw new TypeError(
            `permdock/mcp: tool ${name} sets ${field}, but with enforce: 'procedure' its procedure decides.`,
          );
        }
      }
      const permission =
        config["permission"] === undefined
          ? enforcement.permissionFor(name)
          : config["permission"];
      // A listed tool shows when one permission is usable; its procedure decides.
      return toolAccess(name, permission, true);
    }
    if (!Object.hasOwn(config, "permission")) {
      requirePermission("tool", name, config);
    }
    const access = toolAccess(
      name,
      config["permission"],
      config["anyOf"] === true,
    );
    const given = fields.filter((field) => config[field] !== undefined);
    if (access === null && given.length > 0) {
      throw new TypeError(
        `permdock/mcp: tool ${name} is public (permission: null) but sets ${given.join(", ")}.`,
      );
    }
    if (config["data"] !== undefined && config["rows"] !== undefined) {
      throw new TypeError(
        `permdock/mcp: tool ${name} sets both data and rows; rows loads every row.`,
      );
    }
    if (
      config["longRunning"] === true &&
      (config["rows"] !== undefined || (access?.permissions.length ?? 0) > 1)
    ) {
      throw new TypeError(
        `permdock/mcp: tool ${name} sets longRunning, which takes one permission and no rows.`,
      );
    }
    return access;
  };
  /**
   * With `enforce: 'procedure'` the handler runs undecided: the procedure it
   * calls decides. A public tool runs undecided too.
   */
  const wrapTool = (
    tool: () => string,
    access: Access | null,
    reach: Reach | undefined,
    declared: readonly [string, ...string[]] | undefined,
    loaders: ToolLoaders,
    handler: Handler,
    longRunning: boolean,
  ): Handler =>
    enforcement === undefined && access !== null && reach !== undefined
      ? guardTool(tool, access, reach, declared, loaders, handler, longRunning)
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
    const access = toolAccessFor(name, config);
    const [lead, ...others] = access?.permissions ?? [];
    const permission = others.length === 0 ? lead : undefined;
    const view = uiResourceUri(config["_meta"]);
    const linked = view === undefined ? undefined : uiLinks.get(view);
    if (
      view !== undefined &&
      linked !== undefined &&
      linked.permission.key !== permission?.key
    ) {
      throw new TypeError(
        `permdock/mcp: tools ${linked.tool} and ${name} link ${view} under different permissions; give the resource its own permission.`,
      );
    }
    const {
      permission: _permission,
      anyOf: _anyOf,
      data,
      rows,
      scopeChallenge,
      longRunning: rawLongRunning,
      oauthScopes: rawScopes,
      ...passthrough
    } = config;
    // SAFETY: GuardedMcpServer types a tool config's data and rows as loaders over the tool args.
    const loaders = {
      data: data as ((args: unknown) => unknown) | undefined,
      rows: rows as ((args: unknown) => unknown) | undefined,
    };
    const longRunning = rawLongRunning === true;
    const declared = declaredScopes(
      name,
      rawScopes === undefined ? enforcement?.oauthScopesFor?.(name) : rawScopes,
    );
    const reach =
      lead === undefined ? undefined : reachOf(checks.policy, lead, declared);
    let current = name;
    const tool = (): string => current;
    // SAFETY: GuardedMcpServer types annotations as ToolHints and scopeChallenge as its handler.
    const ownAnnotations = passthrough["annotations"] as ToolHints | undefined;
    // SAFETY: GuardedMcpServer types a tool config's scopeChallenge as ScopeChallengeHandler.
    const ownChallenge = scopeChallenge as ScopeChallengeHandler | undefined;
    const registered = originalTool(
      name,
      compact({
        ...passthrough,
        annotations:
          access === null
            ? ownAnnotations
            : { ...annotationsOf(access), ...ownAnnotations },
        scopeChallenge:
          reach === undefined
            ? ownChallenge
            : challengeFor(ownChallenge, reach.scopes, reach.challenge),
      }),
      wrapTool(tool, access, reach, declared, loaders, handler, longRunning),
    );
    tools.set(name, access);
    if (declared !== undefined) {
      toolScopes.set(name, declared);
    }
    if (
      view !== undefined &&
      linked === undefined &&
      permission !== undefined
    ) {
      uiLinks.set(view, { tool: name, permission });
    }
    guardUpdates(
      registered,
      (callback) =>
        wrapTool(tool, access, reach, declared, loaders, callback, longRunning),
      (from, to) => {
        tools.delete(from);
        toolScopes.delete(from);
        if (to !== null) {
          tools.set(to, access);
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
        { capabilities, name: () => name },
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
    const inherits =
      config["permission"] === undefined &&
      typeof uriOrTemplate === "string" &&
      uriOrTemplate.startsWith(UI_SCHEME);
    const own = inherits
      ? undefined
      : requirePermission("resource", name, config);
    /**
     * A `ui://` view without its own permission takes the one of the tool
     * linking it; unlinked, it denies.
     */
    const permissionNow = (): Permission | undefined =>
      own ??
      (typeof uriOrTemplate === "string"
        ? uiLinks.get(uriOrTemplate)?.permission
        : undefined);
    const {
      permission: _permission,
      data,
      scopeChallenge,
      ...passthrough
    } = config;
    // SAFETY: GuardedMcpServer types a resource config's data as a loader over the read args.
    const load = data as ((...args: unknown[]) => unknown) | undefined;
    // SAFETY: GuardedMcpServer types a resource config's scopeChallenge as ScopeChallengeHandler.
    const ownChallenge = scopeChallenge as ScopeChallengeHandler | undefined;
    const wrap =
      (callback: Handler): Handler =>
      (...params: unknown[]): unknown => {
        const permission = permissionNow();
        if (permission === undefined) {
          return Promise.reject(
            new Error(`Denied: resource ${name} is linked to no guarded tool.`),
          );
        }
        return guard(
          checks,
          permission,
          load,
          callback,
          (args) => args.slice(0, -1),
          throwRefusal,
          { capabilities, name: () => name },
        )(...params);
      };
    const registered = originalResource(
      name,
      uriOrTemplate,
      {
        ...passthrough,
        scopeChallenge: (
          context: Parameters<ScopeChallengeHandler>[0],
        ): ReturnType<ScopeChallengeHandler> => {
          const permission = permissionNow();
          return permission === undefined
            ? ownChallenge?.(context)
            : challengeFor(
                ownChallenge,
                scopesReaching(checks.policy, permission),
                challengeScope(checks.policy, permission),
              )(context);
        },
      },
      wrap(read),
    );
    if (typeof uriOrTemplate === "string") {
      if (own === undefined) {
        views.add(uriOrTemplate);
      } else {
        resources.set(uriOrTemplate, own);
      }
    } else if (own !== undefined) {
      templates.push({ template: uriOrTemplate, permission: own });
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
