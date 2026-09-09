import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { ApprovalInspectResult } from '../approvals/types.ts';
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
  McpServerLike,
  McpToolConfig,
  McpToolHandler,
  McpToolResult,
} from './types.ts';

import { inspectApproval, requestApproval } from '../approvals/helpers.ts';
import { compact } from '../core/compact.ts';
import { describe } from '../core/describe.ts';
import { PermDockValidationError } from '../core/errors.ts';
import { createPermDock as createCorePermDock } from '../core/permdock.ts';
import { applyOtel } from '../otel/instrument.ts';
import { InsufficientScopeError } from './errors.ts';

type RegisteredTool = {
  readonly name: string;
  readonly permission: Permission;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAuthInfo(value: unknown): value is McpAuthInfo {
  return isRecord(value);
}

function authInfoOf(extra: unknown): McpAuthInfo {
  if (!isRecord(extra)) {
    return {};
  }
  if (isAuthInfo(extra.authInfo)) {
    return extra.authInfo;
  }
  if (isRecord(extra.http) && isAuthInfo(extra.http.authInfo)) {
    return extra.http.authInfo;
  }
  return extra;
}

function approvalTokenOf(authInfo: McpAuthInfo): string | undefined {
  const token = authInfo.extra?.approval;
  return typeof token === 'string' && token !== '' ? token : undefined;
}

function authorizationDetailsOf(
  authInfo: McpAuthInfo,
): readonly AuthorizationDetail[] | undefined {
  return authInfo.extra?.authorizationDetails;
}

function delegationOf(authInfo: McpAuthInfo): Delegation | undefined {
  return compact<Delegation>({
    scopes: authInfo.scopes,
    authorizationDetails: authorizationDetailsOf(authInfo),
  });
}

async function resolveTenant(
  tenant: McpPermDockOptions['tenant'],
  authInfo: McpAuthInfo,
): Promise<string | undefined> {
  if (tenant === undefined || typeof tenant === 'string') {
    return tenant;
  }
  try {
    return await tenant(authInfo);
  } catch {
    return undefined;
  }
}

function hasScope(authInfo: McpAuthInfo, scope: string): boolean {
  const scopes = authInfo.scopes;
  if (scopes === undefined) {
    return false;
  }
  return scopes.includes(scope);
}

function validateInput(
  schema: StandardSchemaV1 | undefined,
  args: unknown,
  permission: Permission,
): unknown {
  if (schema === undefined) {
    return args;
  }
  const result = schema['~standard'].validate(args);
  if (
    result !== null &&
    typeof result === 'object' &&
    'then' in result &&
    typeof result.then === 'function'
  ) {
    throw new PermDockValidationError({
      code: 'async-schema',
      permission: permission.key,
      resource: permission.resource,
      boundary: 'mcp-args',
      message: `${permission.key}: inputSchema is async.`,
    });
  }
  const sync = result as StandardSchemaV1.Result<unknown>;
  if ('issues' in sync && sync.issues !== undefined) {
    throw new PermDockValidationError({
      code: 'invalid-data',
      permission: permission.key,
      resource: permission.resource,
      issues: sync.issues,
      boundary: 'mcp-args',
      message: `${permission.key}: invalid tool arguments.`,
    });
  }
  return (sync as { readonly value: unknown }).value;
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  if (data !== null && typeof data === 'object' && 'id' in data) {
    const id = (data as { readonly id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') {
      return { type: permission.resource, id: String(id) };
    }
  }
  return { type: permission.resource };
}

function refusal(
  decision: Extract<Decision, { readonly outcome: 'denied' }>,
  permission: Permission,
  data: unknown,
): McpToolResult {
  const described = describe(decision);
  const alternatives = decision.alternatives.map((leaf) => leaf.key);
  const resource = resourceRef(permission, data);
  const suffix =
    resource.id === undefined
      ? permission.key
      : `${permission.key} on ${resource.id}`;
  const maybe =
    alternatives.length === 0 ? '' : ` You may: ${alternatives.join(', ')}.`;
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Denied: ${suffix}.${maybe}`,
      },
    ],
    structuredContent: {
      outcome: 'denied' as const,
      permission: permission.key,
      resource,
      denials: decision.denials,
      alternatives,
      detail: described.detail,
    },
  };
}

function validationRefusal(error: PermDockValidationError): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: error.message }],
    structuredContent: {
      outcome: 'denied' as const,
      permission: error.permission,
      denials: [{ role: null, reason: 'validation' }],
      alternatives: [],
      issues: error.issues,
    },
  };
}

function elicitation(
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
  permission: Permission,
  data: unknown,
): McpToolResult {
  return {
    content: [
      {
        type: 'text',
        text: describe(decision).detail,
      },
    ],
    structuredContent: {
      outcome: 'approval-required' as const,
      permission: permission.key,
      resource: resourceRef(permission, data),
      token: decision.token,
      elicitation: { mode: 'approval', token: decision.token },
    },
  };
}

function resumeMatches(
  inspected: ApprovalInspectResult,
  permission: Permission,
  resource: { readonly type: string; readonly id?: string },
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
): boolean {
  if (!inspected.ok) {
    return false;
  }
  if (inspected.request.token !== decision.token) {
    return false;
  }
  if (inspected.request.permission !== permission.key) {
    return false;
  }
  if (
    inspected.request.resource.id !== undefined &&
    inspected.request.resource.id !== resource.id
  ) {
    return false;
  }
  return true;
}

function grantedDecision(
  dock: PermDock,
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
): Decision {
  const principal = dock.subject.principal;
  if (principal === null) {
    return {
      outcome: 'denied',
      denials: [{ role: null, reason: 'approval' }],
      alternatives: [],
    };
  }
  return {
    outcome: 'granted',
    subject: { ...dock.subject, principal },
    matched: decision.grant,
    token: decision.token,
  };
}

async function applyResume(
  decision: Decision,
  permission: Permission,
  dock: PermDock,
  store: McpPermDockOptions['store'],
  authInfo: McpAuthInfo,
  data: unknown,
): Promise<Decision> {
  const header = approvalTokenOf(authInfo);
  const resource = resourceRef(permission, data);
  if (header === undefined) {
    if (decision.outcome === 'approval-required' && store !== undefined) {
      await requestApproval(
        store,
        decision,
        compact({
          permission,
          resource,
          subject: dock.subject,
          adapter: 'mcp',
        }),
      );
    }
    return decision;
  }
  if (store === undefined) {
    return {
      outcome: 'denied',
      denials: [
        { role: null, reason: 'approval', detail: 'approval-not-found' },
      ],
      alternatives: [],
    };
  }
  const inspected = await inspectApproval(store, header);
  if (!inspected.ok) {
    return {
      outcome: 'denied',
      denials: [{ role: null, reason: 'approval', detail: inspected.detail }],
      alternatives: [],
    };
  }
  switch (decision.outcome) {
    case 'granted':
    case 'denied':
      return decision;
    case 'approval-required':
      if (!resumeMatches(inspected, permission, resource, decision)) {
        return {
          outcome: 'denied',
          denials: [
            { role: null, reason: 'approval', detail: 'approval-mismatch' },
          ],
          alternatives: [],
        };
      }
      return grantedDecision(dock, decision);
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

function snapshotAllows(dock: PermDock, permission: Permission): boolean {
  const snapshot = dock.snapshot();
  if (typeof snapshot === 'string' || snapshot instanceof Promise) {
    return false;
  }
  return snapshot.grants.some(
    (grant) => grant.permission === permission.key && grant.effect === 'allow',
  );
}

export function createPermDock<TUser, TPrincipal extends Principal = Principal>(
  policy: Policy<TUser, TPrincipal>,
  options: McpPermDockOptions<TUser>,
): McpPermDock {
  const instanceFor = async (authInfo: McpAuthInfo): Promise<PermDock> => {
    let user: TUser | null = null;
    try {
      user = await options.subject(authInfo);
    } catch {
      user = null;
    }
    const tenant = await resolveTenant(options.tenant, authInfo);
    const actor =
      typeof authInfo.clientId === 'string' && authInfo.clientId !== ''
        ? { id: authInfo.clientId, kind: 'mcp-client' as const }
        : undefined;
    return applyOtel(
      await createCorePermDock(
        policy,
        user,
        compact({
          tenant,
          actor,
          delegation: delegationOf(authInfo),
          memberships: options.memberships,
          customRoles: options.customRoles,
          sink: options.sink,
        }),
      ),
      options.otel,
    );
  };

  const protectServer = <S extends McpServerLike>(
    server: S,
  ): GuardedMcpServer<S> => {
    const registered: RegisteredTool[] = [];
    const original = server.registerTool.bind(server);

    const registerTool = (
      name: string,
      config: McpToolConfig,
      handler: McpToolHandler,
    ): unknown => {
      const permission = config.permission;
      registered.push({ name, permission });
      const wrapped: McpToolHandler = async (args, extra) => {
        const authInfo = authInfoOf(extra);
        if (!hasScope(authInfo, permission.scope)) {
          throw new InsufficientScopeError(
            permission.scope,
            authInfo.scopes ?? [],
          );
        }
        let validated: unknown;
        try {
          validated = validateInput(config.inputSchema, args, permission);
        } catch (error) {
          if (error instanceof PermDockValidationError) {
            return validationRefusal(error);
          }
          throw error;
        }
        let data: unknown;
        if (config.data !== undefined) {
          data = await config.data(validated);
        }
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
        )(
          permission,
          data,
          compact({
            source: 'adapter' as const,
            adapter: 'mcp',
            boundary: 'mcp-args' as const,
          }),
        );
        const decision = await applyResume(
          raw,
          permission,
          dock,
          options.store,
          authInfo,
          data,
        );
        switch (decision.outcome) {
          case 'granted':
            return handler(validated, extra);
          case 'denied':
            return refusal(decision, permission, data);
          case 'approval-required':
            return elicitation(decision, permission, data);
          default: {
            const exhaustive: never = decision;
            return exhaustive;
          }
        }
      };

      return original(
        name,
        compact({
          description: config.description,
          inputSchema: config.inputSchema,
          scopeChallenge: { scope: permission.scope },
        }),
        wrapped,
      );
    };

    const listTools = async (
      authInfo: McpAuthInfo,
    ): Promise<readonly { readonly name: string }[]> => {
      const dock = await instanceFor(authInfo);
      const visible: { readonly name: string }[] = [];
      for (const tool of registered) {
        const allowed =
          tool.permission.kind === 'collection'
            ? (dock.can as (permission: Permission) => boolean)(tool.permission)
            : snapshotAllows(dock, tool.permission);
        if (allowed) {
          visible.push({ name: tool.name });
        }
      }
      return visible;
    };

    server.registerTool = registerTool as McpServerLike['registerTool'];
    const guarded = server as GuardedMcpServer<S>;
    guarded.listTools = listTools;
    return guarded;
  };

  return { protectServer };
}
