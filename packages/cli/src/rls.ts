import type { CliIo, PermDockConfig, RlsDialect, RlsTarget } from './types.ts';

import { runRlsGenerate } from './rls-generate.ts';
import { runRlsImport } from './rls-import.ts';
import { parseRbacAuthorize } from './rls-rbac.ts';
import { runRlsVerify } from './rls-verify.ts';

export const RLS_HELP = `permdock rls generate | import | verify

  generate --target drizzle|sql|prisma --dialect supabase|neon|guc
           [--rbac supabase] [--rbac-schema public] [--authorize database|jwt]
           [--memberships <table>:tenant,user,role]
           [--policy-per-role] [--policy-name '{table}_{op}'] [--tenant-type uuid]
           [--out <path>] [--check] [--skip-closures] [--inline-functions] [--force] [--guc-prefix app]
  import   --sql schema.sql | --db $DATABASE_URL --out src/permissions.generated.ts
           [--schema zod|valibot|arktype] [--memberships <table>:tenant,user,role]
  verify   [--db $DATABASE_URL] [--fixtures rls.fixtures.ts] [--format pgtap|node]

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
      const dialect = asDialect(input.dialect);
      if (target === undefined) {
        return {
          code: 2,
          output: 'rls generate --target must be drizzle, sql or prisma',
        };
      }
      if (dialect === undefined) {
        return {
          code: 2,
          output: 'rls generate --dialect must be supabase, neon or guc',
        };
      }
      const generated = await runRlsGenerate({
        cwd: input.cwd,
        config: input.config,
        target,
        dialect,
        rbac: input.rbac,
        ...(input.rbacSchema === undefined
          ? {}
          : { rbacSchema: input.rbacSchema }),
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
        ...(input.gucPrefix === undefined
          ? {}
          : { gucPrefix: input.gucPrefix }),
        policyPerRole: input.policyPerRole,
        ...(input.policyName === undefined
          ? {}
          : { policyName: input.policyName }),
        ...(input.tenantType === undefined
          ? {}
          : { tenantType: input.tenantType }),
      });
      return generated;
    }
    case 'import':
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
    case 'verify': {
      const format = input.format ?? 'node';
      if (format !== 'node' && format !== 'pgtap') {
        return { code: 2, output: 'rls verify --format must be pgtap or node' };
      }
      const verified = await runRlsVerify({
        cwd: input.cwd,
        config: input.config,
        format,
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
