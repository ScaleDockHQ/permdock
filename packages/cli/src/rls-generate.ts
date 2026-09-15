import type { Policy } from 'permdock';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { CompiledPolicy } from './rls-compile.ts';
import type { RlsSqlContext } from './rls-sql.ts';
import type {
  CliIo,
  PermDockConfig,
  RlsDialect,
  RlsMemberships,
  RlsTarget,
} from './types.ts';

import { asPolicy, loadModule, pickNamed } from './load.ts';
import { compileGrant, ensureSelectCoverage, tableFor } from './rls-compile.ts';
import {
  defaultOut,
  emitDrizzle,
  emitPrisma,
  emitSql,
  rbacScaffold,
} from './rls-emit.ts';
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

export async function runRlsGenerate(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly target: RlsTarget;
  readonly dialect: RlsDialect;
  readonly out?: string;
  readonly from?: string;
  readonly memberships?: string;
  readonly rbac: boolean;
  readonly check: boolean;
  readonly skipClosures: boolean;
  readonly inlineFunctions: boolean;
  readonly gucPrefix?: string;
  readonly io: CliIo;
}): Promise<GenerateOutcome> {
  const policy = await loadPolicy(input.cwd, input.config, input.from);
  const memberships: RlsMemberships | undefined =
    parseMembershipsFlag(input.memberships) ?? input.config.rls?.memberships;
  const ctx: RlsSqlContext = {
    dialect: input.dialect,
    tenantClaim: input.config.rls?.tenantClaim ?? 'tenant_id',
    gucPrefix: input.gucPrefix ?? input.config.rls?.gucPrefix ?? 'app',
    inlineFunctions:
      input.inlineFunctions || input.config.rls?.inlineFunctions === true,
    ...(memberships === undefined ? {} : { memberships }),
  };
  const warnings: string[] = [];
  const compiled: CompiledPolicy[] = [];
  for (const role of policy.roles) {
    for (const grant of role.grants) {
      const item = compileGrant(
        grant,
        policy,
        ctx,
        input.config.rls?.tables,
        input.rbac,
        warnings,
        input.skipClosures,
      );
      if (item !== undefined) {
        compiled.push(item);
      }
    }
  }
  const withSelect = ensureSelectCoverage(compiled, warnings);
  const rbac = input.rbac ? rbacScaffold(policy) : '';
  let text: string;
  switch (input.target) {
    case 'sql':
      text = emitSql(withSelect, rbac);
      break;
    case 'drizzle':
      text = emitDrizzle(withSelect, rbac);
      break;
    case 'prisma':
      text = emitPrisma(withSelect, rbac);
      break;
    default: {
      const exhaustive: never = input.target;
      return exhaustive;
    }
  }
  const columns = new Set<string>();
  for (const role of policy.roles) {
    for (const grant of role.grants) {
      const where = grant.where;
      if (where !== undefined && 'field' in where) {
        columns.add(
          `${tableFor(grant.permission.resource, input.config.rls?.tables)}.${where.field}`,
        );
      }
    }
  }
  for (const column of columns) {
    warnings.push(`index suggestion: create index on ${column}`);
  }
  const outRel = input.out ?? input.config.rls?.out ?? defaultOut(input.target);
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
