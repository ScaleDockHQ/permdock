import type { CliIo, PermDockConfig, RlsDialect, RlsTarget } from './types.ts';

import { requirePeer } from './peer.ts';
import { runRlsGenerate } from './rls-generate.ts';
import { diffRls, expectedRls, introspectRls } from './rls-introspect.ts';
import { parseRbacAuthorize } from './rls-rbac.ts';
import { runRlsVerify } from './rls-verify.ts';

export const RLS_HELP = `permdock rls generate | import | verify

  generate --target drizzle|sql|prisma --dialect supabase|neon|guc
           [--rbac supabase] [--rbac-schema public] [--authorize database|jwt]
           [--memberships <table>:tenant,user,role]
           [--policy-per-role] [--policy-name '{table}_{op}'] [--tenant-type uuid] [--custom-roles]
           [--capabilities] [--fields views [--revoke-columns]]
           [--out <path>] [--check] [--skip-closures] [--inline-functions] [--force] [--guc-prefix app]
  import   --sql schema.sql | --db $DATABASE_URL --out src/permissions.generated.ts
           [--schema zod|valibot|arktype] [--memberships <table>:tenant,user,role]
  verify   [--db $DATABASE_URL] [--fixtures rls.fixtures.ts] [--format pgtap|node] [--tree]
           [--introspect --db $DATABASE_URL, with the generate flags]

Never emits service_role. memberOf compiles through the dialect memberships mapping.
`;

export type RlsRunInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly rest: readonly string[];
  readonly target: string | undefined;
  readonly dialect: string | undefined;
  readonly out: string | undefined;
  readonly from: string | undefined;
  readonly sql: string | undefined;
  readonly db: string | undefined;
  readonly fixtures: string | undefined;
  readonly schema: string | undefined;
  readonly memberships: string | undefined;
  readonly format: string | undefined;
  readonly rbac: boolean;
  readonly rbacSchema: string | undefined;
  readonly authorize: string | undefined;
  readonly check: boolean;
  readonly skipClosures: boolean;
  readonly inlineFunctions: boolean;
  readonly force: boolean;
  readonly gucPrefix: string | undefined;
  readonly policyPerRole: boolean;
  readonly policyName: string | undefined;
  readonly tenantType: string | undefined;
  readonly customRoles: boolean;
  readonly capabilities: boolean;
  readonly fields: string | undefined;
  readonly revokeColumns: boolean;
  readonly tree: boolean;
  readonly introspect: boolean;
  readonly io: CliIo;
};

function asTarget(value: string | undefined): RlsTarget | undefined {
  if (
    value === undefined ||
    value === 'sql' ||
    value === 'drizzle' ||
    value === 'prisma'
  ) {
    return value ?? 'sql';
  }
  return undefined;
}

function asDialect(value: string | undefined): RlsDialect | undefined {
  if (
    value === undefined ||
    value === 'supabase' ||
    value === 'neon' ||
    value === 'guc'
  ) {
    return value ?? 'supabase';
  }
  return undefined;
}

function generateInput(
  input: RlsRunInput,
  target: RlsTarget,
  dialect: RlsDialect,
): Parameters<typeof runRlsGenerate>[0] {
  return {
    cwd: input.cwd,
    config: input.config,
    target,
    dialect,
    rbac: input.rbac,
    ...(input.rbacSchema === undefined ? {} : { rbacSchema: input.rbacSchema }),
    ...(input.authorize === undefined
      ? {}
      : { authorize: parseRbacAuthorize(input.authorize) ?? 'database' }),
    check: input.check,
    skipClosures: input.skipClosures,
    inlineFunctions: input.inlineFunctions,
    force: input.force,
    io: input.io,
    ...(input.out === undefined ? {} : { out: input.out }),
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.memberships === undefined
      ? {}
      : { memberships: input.memberships }),
    ...(input.gucPrefix === undefined ? {} : { gucPrefix: input.gucPrefix }),
    policyPerRole: input.policyPerRole,
    ...(input.policyName === undefined ? {} : { policyName: input.policyName }),
    ...(input.tenantType === undefined ? {} : { tenantType: input.tenantType }),
    customRoles: input.customRoles,
    capabilities: input.capabilities,
    ...(input.fields === undefined ? {} : { fields: input.fields }),
    revokeColumns: input.revokeColumns,
  };
}

/** `verify --introspect`: the catalogs against what `generate` would write with the same flags. */
async function introspect(
  input: RlsRunInput,
): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  if (input.db === undefined) {
    return {
      code: 2,
      output: 'PermDock CLI: rls verify --introspect needs --db',
    };
  }
  const dialect = asDialect(input.dialect ?? input.config.rls?.dialect);
  if (dialect === undefined) {
    return {
      code: 2,
      output:
        'rls verify --dialect (or rls.dialect) must be supabase, neon or guc',
    };
  }
  const generated = await runRlsGenerate({
    ...generateInput(input, 'sql', dialect),
    check: false,
    write: false,
  });
  if (generated.code !== 0 || generated.policies === undefined) {
    return { code: 2, output: generated.output };
  }
  const expected = expectedRls(generated.policies, generated.text);
  try {
    const actual = await introspectRls(input.db, expected);
    const drift = diffRls(expected, actual, {
      columnGrants: (input.fields ?? input.config.rls?.fields) === 'views',
    });
    if (drift.length > 0) {
      return { code: 1, output: drift.join('\n') };
    }
    return {
      code: 0,
      output: `introspected ${String(expected.policies.length)} policies on ${String(expected.tables.length)} table(s) and ${String(expected.helpers.length)} helper(s): no drift`,
    };
  } catch (cause) {
    return {
      code: 2,
      output: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function runRls(
  input: RlsRunInput,
): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const action = input.rest[0];
  if (action === undefined || action === 'help') {
    return { code: 2, output: RLS_HELP };
  }
  switch (action) {
    case 'generate': {
      const target = asTarget(input.target);
      const dialect = asDialect(input.dialect ?? input.config.rls?.dialect);
      if (target === undefined) {
        return {
          code: 2,
          output: 'rls generate --target must be drizzle, sql or prisma',
        };
      }
      if (dialect === undefined) {
        return {
          code: 2,
          output:
            'rls generate --dialect (or rls.dialect) must be supabase, neon or guc',
        };
      }
      return runRlsGenerate(generateInput(input, target, dialect));
    }
    case 'import': {
      await requirePeer(
        () => import('pgsql-parser'),
        'pgsql-parser',
        'permdock rls import',
      );
      const { runRlsImport } = await import('./rls-import.ts');
      return runRlsImport({
        cwd: input.cwd,
        config: input.config,
        schema: input.schema ?? 'zod',
        io: input.io,
        ...(input.sql === undefined ? {} : { sql: input.sql }),
        ...(input.db === undefined ? {} : { db: input.db }),
        ...(input.out === undefined ? {} : { out: input.out }),
        ...(input.memberships === undefined
          ? {}
          : { memberships: input.memberships }),
      });
    }
    case 'verify': {
      if (input.introspect) {
        return introspect(input);
      }
      const format = input.format ?? 'node';
      if (format !== 'node' && format !== 'pgtap') {
        return { code: 2, output: 'rls verify --format must be pgtap or node' };
      }
      const verified = await runRlsVerify({
        cwd: input.cwd,
        config: input.config,
        format,
        tree: input.tree,
        io: input.io,
        ...(input.fixtures === undefined ? {} : { fixtures: input.fixtures }),
        ...(input.db === undefined ? {} : { db: input.db }),
        ...(input.from === undefined ? {} : { from: input.from }),
      });
      return verified;
    }
    default:
      return { code: 2, output: RLS_HELP };
  }
}
