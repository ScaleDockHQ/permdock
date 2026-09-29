import type { Policy } from 'permdock';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { RlsSqlContext } from './rls-sql.ts';
import type {
  CliIo,
  PermDockConfig,
  RlsDialect,
  RlsMemberships,
  RlsTarget,
} from './types.ts';

import { asPolicy, loadModule, pickNamed } from './load.ts';
import { compileGrants } from './rls-compile.ts';
import { defaultOut, emitDrizzle, emitPrisma, emitSql } from './rls-emit.ts';
import { helpersSql } from './rls-helpers.ts';
import { assemblePolicies } from './rls-policies.ts';
import { hookUri, type RbacAuthorizeMode, rbacScaffold } from './rls-rbac.ts';
import { parseMembershipsFlag } from './rls-sql.ts';

export type GenerateOutcome = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
  readonly text: string;
};

async function loadPolicy(
  cwd: string,
  config: PermDockConfig,
  from: string | undefined,
): Promise<Policy> {
  const policyPath =
    from === 'drizzle' ? config.policy : (from ?? config.policy);
  if (policyPath === undefined) {
    throw new Error(
      'PermDock CLI: rls generate needs policy in permdock.config.ts or --from',
    );
  }
  return asPolicy(
    pickNamed(await loadModule(resolve(cwd, policyPath)), ['policy']),
  );
}

function defaultAuthorize(
  rbac: boolean,
  memberships: RlsMemberships | undefined,
): RbacAuthorizeMode {
  if (rbac) {
    return 'database';
  }
  return memberships?.tenant !== undefined || memberships?.team !== undefined
    ? 'database'
    : 'jwt';
}

export async function runRlsGenerate(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly target: RlsTarget;
  readonly dialect: RlsDialect;
  readonly out?: string;
  readonly from?: string;
  readonly memberships?: string;
  readonly rbac: boolean;
  readonly rbacSchema?: string;
  readonly authorize?: RbacAuthorizeMode;
  readonly check: boolean;
  readonly skipClosures: boolean;
  readonly inlineFunctions: boolean;
  readonly force?: boolean;
  readonly gucPrefix?: string;
  readonly io: CliIo;
}): Promise<GenerateOutcome> {
  const policy = await loadPolicy(input.cwd, input.config, input.from);
  const rls = input.config.rls;
  const memberships: RlsMemberships | undefined =
    parseMembershipsFlag(input.memberships) ?? rls?.memberships;
  if (input.rbac && input.dialect !== 'supabase') {
    return {
      code: 2,
      output: `rls generate --rbac supabase needs --dialect supabase (got ${input.dialect})`,
      text: '',
    };
  }
  const schema =
    input.rbacSchema ?? rls?.schema ?? rls?.rbac?.schema ?? 'public';
  const authorize =
    input.authorize ??
    rls?.authorize ??
    rls?.rbac?.authorize ??
    defaultAuthorize(input.rbac, memberships);
  const ctx: RlsSqlContext = {
    dialect: input.dialect,
    tenantClaim: rls?.tenantClaim ?? 'tenant_id',
    gucPrefix: input.gucPrefix ?? rls?.gucPrefix ?? 'app',
    inlineFunctions: input.inlineFunctions || rls?.inlineFunctions === true,
    schema,
    authorize,
    roleClaim: rls?.roleClaim ?? 'user_role',
    ...(memberships === undefined ? {} : { memberships }),
  };
  const warnings: string[] = [];
  if (authorize === 'database') {
    for (const scope of ['tenant', 'team'] as const) {
      const needs = policy.grants.some((grant) => grant.scope === scope);
      const column =
        scope === 'tenant'
          ? memberships?.tenant?.tenant
          : memberships?.team?.team;
      if (needs && column === undefined) {
        warnings.push(
          `${scope}-scoped grants read the ${scope} memberships table in database mode: pass --memberships <table>:tenant,user,role (or rls.memberships.${scope}), otherwise they deny`,
        );
      }
    }
  }
  const compiled = compileGrants(
    policy,
    ctx,
    rls?.tables,
    warnings,
    input.skipClosures,
  );
  const policies = assemblePolicies(compiled.branches, { perRole: true });
  const rbac = input.rbac
    ? rbacScaffold(policy, {
        schema,
        authorize,
        ...(memberships?.tenant === undefined
          ? {}
          : { memberships: memberships.tenant }),
      })
    : undefined;
  if (input.rbac) {
    warnings.push(
      `enable the hook: [auth.hook.custom_access_token] enabled = true, uri = "${hookUri(schema)}"`,
    );
  }
  const preamble = [
    rbac?.head,
    helpersSql(ctx, compiled.rolePermissions, {
      userRoles: !input.rbac,
      tenantType: 'text',
      teamType: 'text',
    }),
    rbac?.tail,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n');
  const force = input.force === true || rls?.force === true;
  if (force && input.target !== 'sql') {
    warnings.push(
      `--force: ${input.target} has no FORCE ROW LEVEL SECURITY option; run the commented statements in a migration`,
    );
  }
  let text: string;
  switch (input.target) {
    case 'sql':
      text = emitSql(policies, preamble, force);
      break;
    case 'drizzle':
      text = emitDrizzle(policies, preamble, force);
      break;
    case 'prisma':
      text = emitPrisma(policies, preamble, force);
      break;
    default: {
      const exhaustive: never = input.target;
      return exhaustive;
    }
  }
  for (const column of compiled.filtered) {
    warnings.push(`index suggestion: create index on ${column}`);
  }
  const outRel = input.out ?? rls?.out ?? defaultOut(input.target);
  const outPath = resolve(input.cwd, outRel);
  if (input.check) {
    if (!existsSync(outPath)) {
      return {
        code: 1,
        output: `rls generate drift: missing ${outRel}`,
        text,
      };
    }
    if (readFileSync(outPath, 'utf8') === text) {
      return { code: 0, output: 'rls generate up to date', text };
    }
    return { code: 1, output: 'rls generate drift', text };
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  const extra = warnings.length === 0 ? '' : `\n${warnings.join('\n')}`;
  return { code: 0, output: `wrote ${outRel}${extra}`, text };
}
