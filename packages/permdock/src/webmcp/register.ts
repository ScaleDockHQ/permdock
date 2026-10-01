import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Decision } from '../core/decision.ts';
import type { Snapshot } from '../core/interfaces.ts';
import type {
  Permission,
  PermissionTree,
  ResourceNode,
} from '../core/permissions.ts';
import type {
  ModelContext,
  PermissionGroup,
  RegisterToolsHandle,
  RegisterToolsOptions,
  WebMcpPermDock,
  WebMcpToolResult,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { describe } from '../core/describe.ts';
import { PermDockValidationError } from '../core/errors.ts';
import {
  annotationsFor,
  getRegistry,
  isRegistryTree,
  resourceOfNode,
  listPermissions,
} from '../core/permissions.ts';
import { wireDenials } from '../core/wire-denial.ts';

const MISSING_CONTEXT =
  'permdock/webmcp: document.modelContext is absent; registerTools is a no-op.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const CURRENT = Symbol.for('permdock.current');

function current(permdock: WebMcpPermDock): WebMcpPermDock {
  // SAFETY: an optional read of the CURRENT symbol, typeof-checked below.
  const latest = (permdock as { readonly [CURRENT]?: unknown })[CURRENT];
  // SAFETY: the client store defines CURRENT as a getter for its latest instance.
  return typeof latest === 'function'
    ? (latest as () => WebMcpPermDock)()
    : permdock;
}

function snapshotOf(permdock: WebMcpPermDock): Snapshot | undefined {
  const value = permdock.snapshot();
  if (value instanceof Promise || typeof value === 'string') {
    return undefined;
  }
  return value;
}

function toolName(permission: Permission): string {
  return permission.key.replaceAll('.', '_');
}

function untrustedHint(
  permission: Permission,
  fallback: boolean | undefined,
): boolean {
  if (permission.meta.tags?.includes('untrusted') === true) {
    return true;
  }
  return fallback === true;
}

function schemaFor(
  group: PermissionGroup,
  permission: Permission,
  option: StandardSchemaV1 | undefined,
): StandardSchemaV1 | undefined {
  if (
    option !== undefined ||
    'key' in group ||
    permission.kind !== 'instance'
  ) {
    return option;
  }
  if (isRegistryTree(group)) {
    return getRegistry(group).get(permission.resource)?.schema;
  }
  return resourceIn(group, permission.resource)?.schema;
}

function resourceIn(
  group: PermissionTree,
  name: string,
): ResourceNode | undefined {
  const own = resourceOfNode(group);
  if (own !== undefined) {
    return own.name === name ? own : undefined;
  }
  for (const child of Object.values(group)) {
    if (!('key' in child)) {
      const found = resourceIn(child, name);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function jsonSchemaOf(
  schema: StandardSchemaV1 | undefined,
): Record<string, unknown> | undefined {
  if (schema === undefined) {
    return undefined;
  }
  // SAFETY: an optional read of Standard JSON Schema's jsonSchema; it is checked before use.
  const standard = schema['~standard'] as {
    readonly jsonSchema?: unknown;
  };
  // SAFETY: Standard JSON Schema's shape; input is typeof-checked before the call.
  const converter = standard.jsonSchema as
    | { readonly input?: (options: { readonly target: string }) => unknown }
    | undefined;
  if (typeof converter?.input === 'function') {
    try {
      const converted = converter.input({ target: 'draft-2020-12' });
      if (isRecord(converted)) {
        return converted;
      }
    } catch {
      return { type: 'object' };
    }
  }
  if (isRecord(standard.jsonSchema) && converter?.input === undefined) {
    return standard.jsonSchema;
  }
  return { type: 'object' };
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
      boundary: 'webmcp-args',
      message: `${permission.key}: inputSchema is async.`,
      issues: [],
    });
  }
  // SAFETY: a thenable result threw above, so this is the synchronous Result.
  const sync = result as StandardSchemaV1.Result<unknown>;
  if ('issues' in sync && sync.issues !== undefined) {
    throw new PermDockValidationError({
      code: 'invalid-data',
      permission: permission.key,
      resource: permission.resource,
      boundary: 'webmcp-args',
      message: `${permission.key}: invalid tool arguments.`,
      issues: [...sync.issues],
    });
  }
  return 'value' in sync ? sync.value : args;
}

function bindTenant(
  input: unknown,
  tenantKey: string | undefined,
  tenant: string | undefined,
):
  | { readonly ok: true; readonly input: unknown }
  | { readonly ok: false; readonly reason: 'tenant-mismatch' } {
  if (tenantKey === undefined || tenant === undefined) {
    return { ok: true, input };
  }
  if (!isRecord(input)) {
    return { ok: true, input: { [tenantKey]: tenant } };
  }
  const given = input[tenantKey];
  if (given !== undefined && given !== tenant) {
    return { ok: false, reason: 'tenant-mismatch' };
  }
  return { ok: true, input: { ...input, [tenantKey]: tenant } };
}

function resourceRef(
  permission: Permission,
  data: unknown,
): { readonly type: string; readonly id?: string } {
  if (permission.kind === 'collection' || !isRecord(data)) {
    return { type: permission.resource };
  }
  const id = data['id'];
  return typeof id === 'string' || typeof id === 'number'
    ? { type: permission.resource, id: String(id) }
    : { type: permission.resource };
}

function alternativesOf(
  decision: Extract<Decision, { readonly outcome: 'denied' }>,
): string[] {
  return decision.alternatives.map((leaf) => leaf.key);
}

function deniedResult(
  decision: Extract<Decision, { readonly outcome: 'denied' }>,
  permission: Permission,
  data: unknown,
): WebMcpToolResult {
  const described = describe(decision);
  const alternatives = alternativesOf(decision);
  const suffix =
    alternatives.length === 0 ? '' : ` You may: ${alternatives.join(', ')}.`;
  return {
    isError: true,
    content: [{ type: 'text', text: `Denied: ${permission.key}.${suffix}` }],
    structuredContent: compact({
      outcome: 'denied' as const,
      permission: permission.key,
      resource: resourceRef(permission, data),
      denials: wireDenials(decision.denials),
      alternatives,
      detail: described.detail,
    }),
  };
}

function approvalResult(
  decision: Extract<Decision, { readonly outcome: 'approval-required' }>,
  permission: Permission,
  data: unknown,
): WebMcpToolResult {
  return {
    content: [{ type: 'text', text: describe(decision).detail }],
    structuredContent: {
      outcome: 'approval-required' as const,
      permission: permission.key,
      resource: resourceRef(permission, data),
      token: decision.token,
    },
  };
}

function validationResult(error: PermDockValidationError): WebMcpToolResult {
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

function problemResult(error: unknown): WebMcpToolResult | undefined {
  if (
    error !== null &&
    typeof error === 'object' &&
    'toProblemDetails' in error &&
    typeof error.toProblemDetails === 'function'
  ) {
    // SAFETY: toProblemDetails is the PermDock error method; it returns Problem Details with title and detail.
    const problem = (
      error as { toProblemDetails: () => { title: string; detail: string } }
    ).toProblemDetails();
    return {
      isError: true,
      content: [{ type: 'text', text: `${problem.title}: ${problem.detail}` }],
      structuredContent: { outcome: 'denied' as const, problem },
    };
  }
  if (isRecord(error) && error['type'] === 'application/problem+json') {
    const title =
      typeof error['title'] === 'string' ? error['title'] : 'Denied';
    const detail = typeof error['detail'] === 'string' ? error['detail'] : '';
    return {
      isError: true,
      content: [{ type: 'text', text: `${title}: ${detail}` }],
      structuredContent: { outcome: 'denied' as const, problem: error },
    };
  }
  return undefined;
}

function wrapResult(value: unknown): WebMcpToolResult {
  if (
    isRecord(value) &&
    Array.isArray(value['content']) &&
    value['content'].every(
      (item) =>
        isRecord(item) &&
        item['type'] === 'text' &&
        typeof item['text'] === 'string',
    )
  ) {
    // SAFETY: a record whose content items were each checked above to be a text part.
    return value as unknown as WebMcpToolResult;
  }
  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(value ?? null) }],
  };
}

function instanceAllowed(snapshot: Snapshot, permission: Permission): boolean {
  return snapshot.grants.some(
    (grant) =>
      grant.permission === permission.key &&
      grant.effect === 'allow' &&
      grant.portable !== false,
  );
}

function shouldRegister(
  dock: WebMcpPermDock,
  snapshot: Snapshot,
  permission: Permission,
): boolean {
  if (snapshot.simulated === true) {
    return false;
  }
  if (
    dock.status?.(permission) === 'server-only' ||
    dock.status?.(permission) === 'pending'
  ) {
    return false;
  }
  if (permission.kind === 'collection') {
    return dock.can(permission);
  }
  return instanceAllowed(snapshot, permission);
}

function warnMissing(warn: RegisterToolsOptions['warn']): void {
  if (warn !== undefined) {
    warn(MISSING_CONTEXT);
    return;
  }
  // SAFETY: optional chaining below guards a missing console or warn.
  const consoleLike = (
    globalThis as { readonly console?: { warn?: (message: string) => void } }
  ).console;
  consoleLike?.warn?.(MISSING_CONTEXT);
}

async function runTool(
  permission: Permission,
  raw: unknown,
  options: RegisterToolsOptions,
  dock: WebMcpPermDock,
  schema: StandardSchemaV1 | undefined,
): Promise<WebMcpToolResult> {
  try {
    const validated = validateInput(schema, raw, permission);
    const bound = bindTenant(validated, options.tenantKey, options.tenant);
    if (!bound.ok) {
      return deniedResult(
        {
          outcome: 'denied',
          denials: [{ role: null, reason: 'tenant-mismatch' }],
          alternatives: [],
        },
        permission,
        validated,
      );
    }
    const decision = dock.decide(permission, bound.input);
    switch (decision.outcome) {
      case 'denied':
        return deniedResult(decision, permission, bound.input);
      case 'approval-required': {
        const confirmed = await options.onApprovalRequired?.({
          permission,
          decision,
          input: bound.input,
        });
        if (confirmed !== true) {
          return approvalResult(decision, permission, bound.input);
        }
        break;
      }
      case 'granted':
        break;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
    const handler = options.handlers?.[permission.action];
    if (handler === undefined) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `${permission.key}: no handler registered.`,
          },
        ],
      };
    }
    return wrapResult(
      await handler({ input: bound.input, token: decision.token }),
    );
  } catch (error) {
    if (error instanceof PermDockValidationError) {
      return validationResult(error);
    }
    return (
      problemResult(error) ?? {
        isError: true,
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : 'Tool failed.',
          },
        ],
      }
    );
  }
}

function registerGeneration(
  modelContext: ModelContext,
  group: PermissionGroup,
  options: RegisterToolsOptions,
  signal: AbortSignal,
): void {
  const root = current(options.permdock);
  const dock =
    options.tenant !== undefined && root.tenant !== undefined
      ? root.tenant(options.tenant)
      : root;
  const snapshot = snapshotOf(dock);
  if (snapshot === undefined) {
    return;
  }
  for (const permission of listPermissions(group)) {
    if (!shouldRegister(dock, snapshot, permission)) {
      continue;
    }
    const schema = schemaFor(group, permission, options.schema);
    const tenantTitle =
      options.tenant === undefined ? undefined : ` [tenant ${options.tenant}]`;
    const description = `${permission.meta.description ?? permission.key}${tenantTitle ?? ''}`;
    modelContext.registerTool(
      compact({
        name: toolName(permission),
        title: permission.meta.title ?? permission.action,
        description,
        inputSchema:
          permission.kind === 'instance' || schema !== undefined
            ? jsonSchemaOf(schema)
            : undefined,
        annotations: compact({
          readOnlyHint: annotationsFor(permission).readOnlyHint,
          untrustedContentHint: untrustedHint(
            permission,
            options.untrustedContentHint,
          ),
        }),
        execute: (input: unknown): Promise<WebMcpToolResult> =>
          runTool(permission, input, options, dock, schema),
      }),
      { signal },
    );
  }
}

export function registerTools(
  modelContext: ModelContext | null | undefined,
  group: PermissionGroup,
  options: RegisterToolsOptions,
): RegisterToolsHandle {
  if (modelContext === null || modelContext === undefined) {
    warnMissing(options.warn);
    return {
      unregister(): undefined {
        return undefined;
      },
    };
  }
  let generation: AbortController | undefined;
  const parent = options.signal;
  const start = (): void => {
    generation?.abort();
    if (parent?.aborted === true) {
      return;
    }
    generation = new AbortController();
    registerGeneration(modelContext, group, options, generation.signal);
  };
  start();
  const unsubscribe = options.permdock.subscribe?.(start);
  const unregister = (): void => {
    generation?.abort();
    unsubscribe?.();
  };
  parent?.addEventListener('abort', unregister, { once: true });
  return { unregister };
}
