import type {
  McpServer,
  ResourceTemplate,
  ScopeChallenge,
  ScopeChallengeHandler,
} from '@modelcontextprotocol/server';

import type { Decision } from '../core/decision.ts';
import type { PermDock } from '../core/permdock.ts';
import type { Permission } from '../core/permissions.ts';
import type { Policy } from '../core/policy.ts';
import type {
  AuthorizationDetail,
  Delegation,
  Principal,
} from '../core/subject.ts';
import type {
  GuardedMcpServer,
  McpAuthInfo,
  McpPermDock,
  McpPermDockOptions,
} from './types.ts';

import { mayUse, storedApprovalToken } from '../agent/kernel.ts';
import { boundedMap } from '../agent/lru.ts';
import { resumeDecision } from '../approvals/helpers.ts';
import { compact } from '../core/compact.ts';
import { describe } from '../core/describe.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { applyOtel } from '../otel/instrument.ts';

/** `_meta` key on `tools/call`, `resources/read` and `prompts/get` carrying an approval token. */
export const APPROVAL_META_KEY = 'dev.permdock/approval';

const SESSIONS_PER_SERVER = 1000;

type Context = {
  readonly sessionId?: string;
  readonly mcpReq?: {
    readonly _meta?: Readonly<Record<string, unknown>>;
    readonly notify?: (notification: {
      readonly method: string;
    }) => Promise<void>;
  };
  readonly http?: { readonly authInfo?: McpAuthInfo };
};

type Refusal = {
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>>;
};

type Checked =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: Refusal };

type Handler = (...params: unknown[]) => unknown;

type Registered = {
  update: (updates: Readonly<Record<string, unknown>>) => void;
};

type InnerServer = {
  setRequestHandler: (method: string, ...rest: unknown[]) => void;
  removeRequestHandler: (method: string) => void;
  sendToolListChanged?: () => Promise<void>;
  _getRequestHandler?: (method: string) => Handler | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contextOf(value: unknown): Context {
  return isRecord(value) ? (value as Context) : {};
}

function approvalTokenOf(context: Context): string | undefined {
  // oxlint-disable-next-line no-underscore-dangle -- the MCP protocol names it `_meta`
  const fromMeta = context.mcpReq?._meta?.[APPROVAL_META_KEY];
  if (typeof fromMeta === 'string' && fromMeta !== '') {
    return fromMeta;
  }
  const fromAuth = context.http?.authInfo?.extra?.approval;
  return typeof fromAuth === 'string' && fromAuth !== '' ? fromAuth : undefined;
}

function authorizationDetailsOf(
  authInfo: McpAuthInfo,
): readonly AuthorizationDetail[] | undefined {
  const details = authInfo.extra?.authorizationDetails;
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

function hasScope(authInfo: McpAuthInfo, scope: string): boolean {
  return (authInfo.scopes ?? []).includes(scope);
}

function scopesWith(authInfo: McpAuthInfo, scope: string): string[] {
  return [...new Set([...(authInfo.scopes ?? []), scope])].toSorted();
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  if (isRecord(data)) {
    const id = data.id;
    if (typeof id === 'string' || typeof id === 'number') {
      return { type: permission.resource, id: String(id) };
    }
  }
  return { type: permission.resource };
}

function deniedRefusal(
  decision: Extract<Decision, { readonly outcome: 'denied' }>,
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
    alternatives.length === 0 ? '' : ` You may: ${alternatives.join(', ')}.`;
  return {
    text: `Denied: ${suffix}.${maybe}`,
    structured: {
      outcome: 'denied',
      permission: permission.key,
      resource,
      denials: decision.denials,
      alternatives,
      detail: describe(decision).detail,
    },
  };
}

function approvalRefusal(
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
  permission: Permission,
  data: unknown,
): Refusal {
  return {
    text: describe(decision).detail,
    structured: {
      outcome: 'approval-required',
      permission: permission.key,
      resource: resourceRef(permission, data),
      token: decision.token,
      elicitation: { mode: 'approval', token: decision.token },
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
      outcome: 'denied',
      permission: permission.key,
      resource: { type: permission.resource },
      alternatives: [],
      ...extra,
    },
  };
}

function toolRefusal(refusal: Refusal): unknown {
  return {
    isError: true,
    content: [{ type: 'text', text: refusal.text }],
    structuredContent: refusal.structured,
  };
}

function requirePermission(
  kind: string,
  name: string,
  config: unknown,
): Permission {
  const permission = isRecord(config) ? config.permission : undefined;
  if (!isRecord(permission) || typeof permission.key !== 'string') {
    throw new TypeError(
      `permdock/mcp: ${kind} ${name} has no permission; every guarded registration needs one.`,
    );
  }
  return permission as unknown as Permission;
}

function sessionKey(context: Context): string {
  return context.sessionId ?? '';
}

function throwRefusal(refusal: Refusal): never {
  throw new Error(refusal.text);
}

function challengeFor(
  permission: Permission,
  own: ScopeChallengeHandler | undefined,
): ScopeChallengeHandler {
  return async (context) => {
    const first = await own?.(context);
    if (first !== undefined) {
      return first;
    }
    const authInfo = context.authInfo;
    if (authInfo === undefined || hasScope(authInfo, permission.scope)) {
      return undefined;
    }
    return {
      scopes: scopesWith(authInfo, permission.scope) as [string, ...string[]],
    } satisfies ScopeChallenge;
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
    if (typeof updates.callback === 'function') {
      next.callback = wrap(updates.callback as Handler);
    }
    if (rename !== undefined && currentName !== undefined) {
      const to = updates.name;
      if (typeof to === 'string' || to === null) {
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
  const instanceFor = async (
    authInfo: McpAuthInfo | undefined,
  ): Promise<PermDock> => {
    const material = authInfo ?? {};
    let user: TUser | null = null;
    try {
      user = await options.subject(material);
    } catch {
      user = null;
    }
    let tenant: string | undefined;
    try {
      tenant =
        typeof options.tenant === 'function'
          ? await options.tenant(material)
          : options.tenant;
    } catch {
      tenant = undefined;
    }
    const clientId = authInfo?.clientId;
    const actor =
      typeof clientId === 'string' && clientId !== ''
        ? { id: clientId, kind: 'mcp-client' as const }
        : undefined;
    return applyOtel(
      await createCorePermDock(
        policy,
        user,
        compact({
          tenant,
          actor,
          delegation:
            authInfo === undefined ? undefined : delegationOf(authInfo),
          memberships: options.memberships,
          customRoles: options.customRoles,
          sink: options.sink,
          limits: options.limits,
        }),
      ),
      options.otel,
    );
  };

  const reachable = (
    authInfo: McpAuthInfo | undefined,
    permission: Permission,
  ): boolean =>
    authInfo === undefined
      ? options.requireAuthInfo !== true
      : hasScope(authInfo, permission.scope);

  const check = async (
    permission: Permission,
    load: (() => unknown) | undefined,
    context: Context,
  ): Promise<Checked> => {
    const authInfo = context.http?.authInfo;
    if (authInfo === undefined && options.requireAuthInfo === true) {
      return {
        ok: false,
        refusal: plainRefusal(permission, 'Denied: no verified credentials.', {
          error: 'invalid_token',
        }),
      };
    }
    if (authInfo !== undefined && !hasScope(authInfo, permission.scope)) {
      const scope = scopesWith(authInfo, permission.scope).join(' ');
      return {
        ok: false,
        refusal: plainRefusal(
          permission,
          `Denied: ${permission.key} needs the ${permission.scope} scope.`,
          { error: 'insufficient_scope', scope },
        ),
      };
    }
    let data: unknown;
    if (load !== undefined) {
      try {
        data = await load();
      } catch {
        return {
          ok: false,
          refusal: plainRefusal(
            permission,
            `Denied: ${permission.key} failed closed.`,
            { denials: [{ role: null, reason: 'validation' }] },
          ),
        };
      }
      if (data === null || data === undefined) {
        return {
          ok: false,
          refusal: plainRefusal(
            permission,
            `Denied: ${permission.key} found nothing to decide on.`,
            { denials: [{ role: null, reason: 'validation' }] },
          ),
        };
      }
    }
    try {
      const dock = await instanceFor(authInfo);
      const raw = (
        dock.decide as (
          next: Permission,
          row?: unknown,
          decideOptions?: {
            readonly source: 'adapter';
            readonly adapter: string;
            readonly boundary: 'mcp-args';
          },
        ) => Decision
      )(permission, data, {
        source: 'adapter',
        adapter: 'mcp',
        boundary: 'mcp-args',
      });
      const decision = await resumeDecision({
        decision: raw,
        permission,
        subject: dock.subject,
        store: options.store,
        resource: resourceRef(permission, data),
        adapter: 'mcp',
        token:
          approvalTokenOf(context) ??
          (await storedApprovalToken(options.store, raw, false)),
      });
      switch (decision.outcome) {
        case 'granted':
          return { ok: true };
        case 'denied':
          return {
            ok: false,
            refusal: deniedRefusal(decision, permission, data),
          };
        case 'approval-required':
          return {
            ok: false,
            refusal: approvalRefusal(decision, permission, data),
          };
        default: {
          const exhaustive: never = decision;
          return exhaustive;
        }
      }
    } catch {
      return {
        ok: false,
        refusal: plainRefusal(
          permission,
          `Denied: ${permission.key} failed closed.`,
          {},
        ),
      };
    }
  };

  const visible = async (
    context: Context,
    permissionOf: (key: string) => Permission | undefined,
    keys: readonly string[],
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
      } else if (reachable(authInfo, permission)) {
        guarded.push({ key, permission });
      }
    }
    if (guarded.length === 0) {
      return shown;
    }
    let dock: PermDock;
    try {
      dock = await instanceFor(authInfo);
    } catch {
      // A subject that cannot be built sees no guarded entry.
      return shown;
    }
    for (const entry of guarded) {
      if (mayUse(dock, entry.permission)) {
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
      after?: (context: Context) => Promise<void>,
    ): Handler =>
    async (...params: unknown[]): Promise<unknown> => {
      const context = contextOf(params.at(-1));
      const checked = await check(
        permission,
        load === undefined
          ? undefined
          : (): unknown => load(...dataArgs(params)),
        context,
      );
      const result = checked.ok
        ? await handler(...params)
        : onRefusal(checked.refusal);
      await after?.(context);
      return result;
    };

  const protectServer = (server: McpServer): GuardedMcpServer => {
    const tools = new Map<string, Permission>();
    const prompts = new Map<string, Permission>();
    const resources = new Map<string, Permission>();
    const templates: {
      readonly template: ResourceTemplate;
      readonly permission: Permission;
    }[] = [];
    const lastListed = boundedMap<string, string>(SESSIONS_PER_SERVER);

    const toolPermission = (name: string): Permission | undefined =>
      tools.get(name);
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
        const entries = result[field] as TEntry[];
        const shown = await visible(context, permissionOf, entries.map(keyOf));
        const kept = entries.filter((entry) => shown.has(keyOf(entry)));
        if (remember) {
          lastListed.set(sessionKey(context), [...shown].toSorted().join(','));
        }
        return { ...result, [field]: kept, cacheScope: 'private' };
      };

    const filters: Readonly<
      Record<string, (result: unknown, context: unknown) => Promise<unknown>>
    > = {
      'tools/list': listFilter<{ readonly name: string }>(
        'tools',
        (entry) => entry.name,
        toolPermission,
        true,
      ),
      'prompts/list': listFilter<{ readonly name: string }>(
        'prompts',
        (entry) => entry.name,
        promptPermission,
        false,
      ),
      'resources/list': listFilter<{ readonly uri: string }>(
        'resources',
        (entry) => entry.uri,
        resourcePermission,
        false,
      ),
      'resources/templates/list': listFilter<{ readonly uriTemplate: string }>(
        'resourceTemplates',
        (entry) => entry.uriTemplate,
        templatePermission,
        false,
      ),
    };

    const inner = server.server as unknown as InnerServer;
    const set = inner.setRequestHandler.bind(inner);
    inner.setRequestHandler = (method: string, ...rest: unknown[]): void => {
      const filter = Object.hasOwn(filters, method)
        ? filters[method]
        : undefined;
      const [handler] = rest;
      if (
        filter !== undefined &&
        rest.length === 1 &&
        typeof handler === 'function'
      ) {
        set(method, async (request: unknown, context: unknown) =>
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
      const shown = await visible(context, toolPermission, [...tools.keys()]);
      const after = [...shown].toSorted().join(',');
      if (after === before) {
        return;
      }
      lastListed.set(key, after);
      try {
        await (context.mcpReq?.notify?.({
          method: 'notifications/tools/list_changed',
        }) ?? inner.sendToolListChanged?.());
      } catch {
        // A lost notification only delays the client's next list.
      }
    };

    const guardTool = (
      permission: Permission,
      load: ((args: unknown) => unknown) | undefined,
      handler: Handler,
    ): Handler =>
      guard(
        permission,
        load as ((...args: unknown[]) => unknown) | undefined,
        handler,
        (params) => (params.length >= 2 ? [params[0]] : [undefined]),
        toolRefusal,
        announce,
      );

    // oxlint-disable-next-line typescript/no-deprecated -- bind() resolves to the raw-shape overload
    const originalTool = server.registerTool.bind(server) as unknown as (
      name: string,
      config: Readonly<Record<string, unknown>>,
      handler: Handler,
    ) => Registered;
    const registerTool = (
      name: string,
      config: Readonly<Record<string, unknown>>,
      handler: Handler,
    ): Registered => {
      const permission = requirePermission('tool', name, config);
      const {
        permission: _permission,
        data,
        scopeChallenge,
        ...passthrough
      } = config;
      const load = data as ((args: unknown) => unknown) | undefined;
      const registered = originalTool(
        name,
        {
          ...passthrough,
          scopeChallenge: challengeFor(
            permission,
            scopeChallenge as ScopeChallengeHandler | undefined,
          ),
        },
        guardTool(permission, load, handler),
      );
      tools.set(name, permission);
      let current = name;
      guardUpdates(
        registered,
        (callback) => guardTool(permission, load, callback),
        (from, to) => {
          tools.delete(from);
          if (to !== null) {
            tools.set(to, permission);
            current = to;
          }
        },
        () => current,
      );
      return registered;
    };

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
      const permission = requirePermission('prompt', name, config);
      const {
        permission: _permission,
        data,
        scopeChallenge,
        ...passthrough
      } = config;
      const load = data as ((...args: unknown[]) => unknown) | undefined;
      const wrap = (callback: Handler): Handler =>
        guard(
          permission,
          load,
          callback,
          (params) => (params.length >= 2 ? [params[0]] : [undefined]),
          throwRefusal,
        );
      const registered = originalPrompt(
        name,
        {
          ...passthrough,
          scopeChallenge: challengeFor(
            permission,
            scopeChallenge as ScopeChallengeHandler | undefined,
          ),
        },
        wrap(handler),
      );
      prompts.set(name, permission);
      guardUpdates(registered, wrap);
      return registered;
    };

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
      const permission = requirePermission('resource', name, config);
      const {
        permission: _permission,
        data,
        scopeChallenge,
        ...passthrough
      } = config;
      const load = data as ((...args: unknown[]) => unknown) | undefined;
      const wrap = (callback: Handler): Handler =>
        guard(
          permission,
          load,
          callback,
          (params) => params.slice(0, -1),
          throwRefusal,
        );
      const registered = originalResource(
        name,
        uriOrTemplate,
        {
          ...passthrough,
          scopeChallenge: challengeFor(
            permission,
            scopeChallenge as ScopeChallengeHandler | undefined,
          ),
        },
        wrap(read),
      );
      if (typeof uriOrTemplate === 'string') {
        resources.set(uriOrTemplate, permission);
      } else {
        templates.push({ template: uriOrTemplate, permission });
      }
      guardUpdates(registered, wrap);
      return registered;
    };

    const guarded = server as unknown as Record<string, unknown>;
    guarded.registerTool = registerTool;
    guarded.registerPrompt = registerPrompt;
    guarded.registerResource = registerResource;
    return server as unknown as GuardedMcpServer;
  };

  return { protectServer };
}
