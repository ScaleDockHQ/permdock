import type { Grant, Policy, SnapshotGrant } from 'permdock';

import { createHash } from 'node:crypto';

import type { CatalogDocument, CliIo, PermDockConfig } from './types.ts';

import { catalogForCompare } from './catalog-doc.ts';
import { runCatalog } from './catalog.ts';
import { loadConfiguredPolicy } from './load.ts';

export type PushedPolicy = {
  readonly fingerprint: string;
  readonly scopes: Policy['scopes'];
  readonly grants: readonly (SnapshotGrant & {
    readonly limit?: Grant['limit'];
  })[];
};

export type CloudPushResult = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};

function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return '';
}

/** base64url SHA-256 of the catalog without `generatedAt`; what hosted documents pin as `catalog`. */
export function catalogFingerprint(document: CatalogDocument): string {
  return createHash('sha256')
    .update(catalogForCompare(document))
    .digest('base64url');
}

function pushedGrant(grant: Grant): PushedPolicy['grants'][number] {
  const entry: Record<string, unknown> = {
    permission: grant.permission.key,
    effect: grant.effect,
    role: grant.role,
    to: grant.to,
    where: grant.portable ? grant.where : undefined,
    check: grant.portable ? grant.check : undefined,
    approval: grant.approval,
    scope:
      grant.scope === 'global'
        ? undefined
        : typeof grant.scope === 'string'
          ? grant.scope
          : { resource: grant.scope.resource },
    portable: grant.portable ? undefined : false,
    fields: grant.fields,
    limit: grant.limit,
  };
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as PushedPolicy['grants'][number];
}

/** The code policy as the hosted AuthZEN endpoint evaluates it; closures travel as `portable: false` and deny there. */
export function pushedPolicy(policy: Policy): PushedPolicy {
  return {
    fingerprint: policy.fingerprint,
    scopes: policy.scopes,
    grants: policy.grants
      .filter((grant) => grant.hosted === undefined)
      .map(pushedGrant),
  };
}

export async function runCloud(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly url: string | undefined;
  readonly environment: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<CloudPushResult> {
  const action = input.rest[0];
  if (action !== 'push') {
    return {
      code: 2,
      output: `usage: permdock cloud push [--dry-run] [--url <url>] [--environment <env>]`,
    };
  }
  const built = await runCatalog({
    cwd: input.cwd,
    config: input.config,
    format: 'json',
    from: undefined,
    include: [],
    now: input.now,
    io: input.io,
  });
  if (built.code !== 0) {
    return { code: built.code, output: built.output };
  }
  const catalog = JSON.parse(built.output) as CatalogDocument;
  const fingerprint = catalogFingerprint(catalog);
  const loaded = await loadConfiguredPolicy(input.cwd, input.config.policy);
  const policy = loaded === undefined ? undefined : pushedPolicy(loaded);
  const hostable = catalog.permissions
    .filter((permission) => permission.hostable === true)
    .map((permission) => permission.key);
  const summary = {
    fingerprint,
    permissions: catalog.permissions.length,
    hostable,
    roles: (catalog.roles ?? []).length,
    plans: (catalog.plans ?? []).length,
    grants: policy?.grants.length ?? 0,
  };
  const url = firstNonEmpty(input.url, input.env.PERMDOCK_CLOUD_URL).replace(
    /\/$/u,
    '',
  );
  const environment = firstNonEmpty(
    input.environment,
    input.env.PERMDOCK_CLOUD_ENV,
    input.env.VERCEL_ENV,
    'production',
  );
  const describe = (verb: string): string =>
    input.json
      ? JSON.stringify({ ...summary, environment, status: verb })
      : `${verb} catalog ${fingerprint} (${String(summary.permissions)} permissions, ${String(hostable.length)} hostable) to ${environment}`;
  if (input.dryRun) {
    return { code: 0, output: describe('would push') };
  }
  const key = input.env.PERMDOCK_CLOUD_KEY ?? '';
  if (url === '' || key === '') {
    return {
      code: 2,
      output:
        'permdock cloud push needs PERMDOCK_CLOUD_URL (or --url) and PERMDOCK_CLOUD_KEY in the environment',
    };
  }
  const fetchFn = input.io.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchFn(
      `${url}/v1/environments/${encodeURIComponent(environment)}/catalog`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(
          policy === undefined
            ? { fingerprint, catalog }
            : { fingerprint, catalog, policy },
        ),
      },
    );
  } catch (error) {
    return {
      code: 1,
      output: `PermDock Cloud unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) {
    return {
      code: 1,
      output: `PermDock Cloud rejected the catalog: HTTP ${String(response.status)}`,
    };
  }
  return { code: 0, output: describe('pushed') };
}
