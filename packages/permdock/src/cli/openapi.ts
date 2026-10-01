import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Permission, Policy } from '../index.ts';
import type { OverlayOperation } from '../openapi/types.ts';
import type { CliIo, PermDockConfig } from './types.ts';

import { definePolicy, findPermission, getResource } from '../index.ts';
import { openapiVersion } from '../openapi/emit.ts';
import { createPermDock } from '../openapi/index.ts';
import { asPermissionTree, asPolicy, loadModule, pickNamed } from './load.ts';
import { validateOpenapi, validateOverlay } from './openapi-schema.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeRecord(
  base: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    result[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    result[key] = value;
  }
  return result;
}

/** Keeps what the document already says about a scheme (flow URLs, other flows, description); PermDock owns the scopes. */
function mergeSchemes(
  existing: Readonly<Record<string, unknown>>,
  emitted: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, scheme] of Object.entries(emitted)) {
    const before = existing[name];
    if (!isRecord(before) || !isRecord(scheme)) {
      result[name] = scheme;
      continue;
    }
    const beforeFlows = isRecord(before['flows']) ? before['flows'] : {};
    const flows: Record<string, unknown> = { ...beforeFlows };
    for (const [kind, flow] of Object.entries(
      isRecord(scheme['flows']) ? scheme['flows'] : {},
    )) {
      const previous = beforeFlows[kind];
      flows[kind] =
        isRecord(previous) && isRecord(flow) ? { ...previous, ...flow } : flow;
    }
    result[name] = {
      ...before,
      ...scheme,
      ...(isRecord(scheme['flows']) ? { flows } : {}),
    };
  }
  return result;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function loadPolicy(
  cwd: string,
  config: PermDockConfig,
  from: string | undefined,
): Promise<Policy> {
  const policyPath = from ?? config.policy;
  if (policyPath !== undefined) {
    const abs = resolve(cwd, policyPath);
    return asPolicy(pickNamed(await loadModule(abs), ['policy']));
  }
  const permissionsPath = config.permissions;
  if (permissionsPath === undefined) {
    throw new Error(
      'PermDock CLI: openapi needs --from, policy or permissions in the config',
    );
  }
  const tree = asPermissionTree(
    pickNamed(await loadModule(resolve(cwd, permissionsPath)), ['permissions']),
  );
  return definePolicy(tree, {
    roles: [],
    subject: () => null,
  });
}

function leavesOf(policy: Policy, keys: readonly unknown[]): Permission[] {
  return keys.map((key) => {
    if (typeof key !== 'string') {
      throw new TypeError(
        'PermDock CLI: x-permdock-permissions must be strings',
      );
    }
    const leaf = findPermission(policy.permissions, key);
    if (leaf === undefined) {
      throw new Error(`PermDock CLI: unknown permission '${key}'`);
    }
    return leaf;
  });
}

/** Operations carrying `x-permdock-permissions`, joined by `operationId`; those without one are findings. */
function overlayOperations(
  document: Record<string, unknown>,
  policy: Policy,
): {
  readonly operations: readonly OverlayOperation[];
  readonly unnamed: readonly string[];
  readonly secured: readonly string[];
} {
  const operations: OverlayOperation[] = [];
  const unnamed: string[] = [];
  const secured: string[] = [];
  const paths = isRecord(document['paths']) ? document['paths'] : {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(
      isRecord(item) ? item : {},
    )) {
      if (
        !isRecord(operation) ||
        !Array.isArray(operation['x-permdock-permissions'])
      ) {
        continue;
      }
      const permissions = leavesOf(policy, operation['x-permdock-permissions']);
      const operationId = operation['operationId'];
      if (typeof operationId !== 'string' || operationId.length === 0) {
        unnamed.push(`${method.toUpperCase()} ${path}`);
        continue;
      }
      if (operation['security'] !== undefined) {
        secured.push(operationId);
      }
      operations.push({ operationId, permissions });
    }
  }
  return { operations, unnamed, secured };
}

/** `instance` when any listed permission acts on one row; the id is the last path template parameter. */
function arityOf(
  policy: Policy,
  leaves: readonly { readonly resource: string; readonly action: string }[],
  path: string,
): Record<string, unknown> {
  const instance = leaves.some(
    (leaf) =>
      getResource(policy.permissions, leaf.resource)?.instanceActions.has(
        leaf.action,
      ) === true,
  );
  if (!instance) {
    return { kind: 'collection' };
  }
  const parameter = [...path.matchAll(/\{([^}]+)\}/gu)].at(-1)?.[1];
  return parameter === undefined
    ? { kind: 'instance' }
    : { kind: 'instance', parameter };
}

function applyDocument(
  document: Record<string, unknown>,
  policy: Policy,
  factory: ReturnType<typeof createPermDock>,
  arity: boolean,
  target: '3.1' | '3.2' | '3.3',
): Record<string, unknown> {
  const components = isRecord(document['components'])
    ? document['components']
    : {};
  const schemes = isRecord(components['securitySchemes'])
    ? components['securitySchemes']
    : {};
  const nextSchemes = mergeRecord(
    schemes,
    mergeSchemes(schemes, factory.securitySchemes()),
  );
  const scopeSets: (readonly string[])[] = [];
  const paths = isRecord(document['paths']) ? document['paths'] : {};
  const nextPaths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      nextPaths[path] = item;
      continue;
    }
    const nextItem: Record<string, unknown> = {};
    for (const [method, operation] of Object.entries(item)) {
      if (!isRecord(operation)) {
        nextItem[method] = operation;
        continue;
      }
      const keys = operation['x-permdock-permissions'];
      if (!Array.isArray(keys)) {
        nextItem[method] = operation;
        continue;
      }
      const leaves = leavesOf(policy, keys);
      scopeSets.push(leaves.map((leaf) => leaf.scope));
      const described = mergeRecord(operation, factory.describe(leaves));
      nextItem[method] = arity
        ? mergeRecord(described, {
            'x-permdock-arity': arityOf(policy, leaves, path),
          })
        : described;
    }
    nextPaths[path] = nextItem;
  }
  const requirements = factory.securityProfileRequirements(scopeSets);
  const nextComponents = mergeRecord(
    components,
    mergeRecord(
      { securitySchemes: nextSchemes },
      requirements === undefined
        ? {}
        : { securityProfileRequirements: requirements },
    ),
  );
  return mergeRecord(document, {
    ...(target === '3.3' ? { openapi: openapiVersion(target) } : {}),
    components: nextComponents,
    paths: nextPaths,
    'x-permdock-catalog': factory.catalog(),
  });
}

function urls(
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/** A finding when the source validates but PermDock's output does not. */
function outputConformance(
  source: Record<string, unknown>,
  result: Record<string, unknown>,
  format: 'document' | 'overlay',
  overlay: '1.1' | '1.2',
): string | undefined {
  if (format === 'overlay') {
    if (overlay !== '1.1') {
      return undefined;
    }
    const checked = validateOverlay(result);
    return checked.ok ? undefined : `openapi emit: ${checked.error}`;
  }
  if (!validateOpenapi(source).ok) {
    return undefined;
  }
  const checked = validateOpenapi(result);
  return checked.ok
    ? undefined
    : `openapi emit: ${checked.error}\npass --authorization-url and --token-url, or declare the scheme's flows in the document`;
}

export async function runOpenapi(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly doc: string | undefined;
  readonly out: string | undefined;
  readonly from: string | undefined;
  readonly target: '3.1' | '3.2' | '3.3';
  readonly format: 'document' | 'overlay';
  readonly overlay: '1.1' | '1.2';
  readonly check: boolean;
  readonly profile: 'fapi2' | undefined;
  readonly profileScheme: string | undefined;
  readonly scheme: string;
  readonly metadataUrl: string | undefined;
  readonly deviceFlow: boolean;
  readonly arity?: boolean;
  readonly authorizationUrl?: string | undefined;
  readonly tokenUrl?: string | undefined;
  readonly deviceAuthorizationUrl?: string | undefined;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const action = input.rest[0] ?? 'emit';
  if (action !== 'emit') {
    return {
      code: 2,
      output: 'openapi action must be emit or import',
    };
  }
  if (input.doc === undefined) {
    return { code: 2, output: 'openapi --doc is required' };
  }
  const policy = await loadPolicy(input.cwd, input.config, input.from);
  const factory = createPermDock(policy, {
    target: input.target,
    ...(input.profile === undefined ? {} : { securityProfile: input.profile }),
    ...(input.profileScheme === undefined
      ? {}
      : { profileScheme: input.profileScheme }),
    scheme: {
      name: input.scheme,
      type: 'oauth2',
      ...(input.metadataUrl === undefined
        ? {}
        : { oauth2MetadataUrl: input.metadataUrl }),
      flows: {
        authorizationCode: urls({
          authorizationUrl: input.authorizationUrl,
          tokenUrl: input.tokenUrl,
        }),
        ...(input.deviceFlow
          ? {
              deviceAuthorization: urls({
                deviceAuthorizationUrl: input.deviceAuthorizationUrl,
                tokenUrl: input.tokenUrl,
              }),
            }
          : {}),
      },
    },
  });
  const docPath = resolve(input.cwd, input.doc);
  if (!existsSync(docPath)) {
    return {
      code: 2,
      output: `PermDock CLI: document not found: ${input.doc}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(docPath, 'utf8'));
  } catch {
    return {
      code: 2,
      output: 'PermDock CLI: --doc must be a JSON OpenAPI document',
    };
  }
  if (!isRecord(parsed)) {
    return {
      code: 2,
      output: 'PermDock CLI: OpenAPI document must be an object',
    };
  }
  const covered =
    input.format === 'overlay' ? overlayOperations(parsed, policy) : undefined;
  if (covered !== undefined && covered.unnamed.length > 0) {
    return {
      code: 1,
      output: `openapi emit: an Overlay targets operations by operationId; none on ${covered.unnamed.join(', ')}`,
    };
  }
  if (input.check && covered !== undefined && covered.secured.length > 0) {
    return {
      code: 1,
      output: `openapi drift: the source already sets security the Overlay replaces on ${covered.secured.join(', ')}`,
    };
  }
  const result =
    covered !== undefined
      ? factory.overlay({
          extends: input.doc,
          version: input.overlay,
          operations: covered.operations,
        })
      : applyDocument(
          parsed,
          policy,
          factory,
          input.arity === true,
          input.target,
        );
  const conformance = outputConformance(
    parsed,
    result,
    input.format,
    input.overlay,
  );
  if (conformance !== undefined) {
    return { code: 1, output: conformance };
  }
  const text = stableJson(result);
  const outPath = resolve(input.cwd, input.out ?? input.doc);
  if (input.check) {
    if (!existsSync(outPath)) {
      return {
        code: 1,
        output: `openapi drift: missing ${input.out ?? input.doc}`,
      };
    }
    const current = readFileSync(outPath, 'utf8');
    if (current === text) {
      return { code: 0, output: 'openapi up to date' };
    }
    return { code: 1, output: 'openapi drift' };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  return { code: 0, output: `wrote ${input.out ?? input.doc}` };
}
