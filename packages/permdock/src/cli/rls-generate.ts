import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Policy } from '../index.ts';
import type { RlsSqlContext } from './rls-sql.ts';
import type {
  CliIo,
  PermDockConfig,
  RlsDialect,
  RlsMemberships,
  RlsTarget,
} from './types.ts';

import { scopeList } from '../core/scopes.ts';
import { listRoles } from '../index.ts';
import { supabaseTenantClaim } from '../supabase/budget.ts';
import { asPolicy, loadModule, pickNamed } from './load.ts';
import { breakGlassEntries, breakGlassSql } from './rls-break-glass.ts';
import { compileGrants } from './rls-compile.ts';
import { defaultOut, emitDrizzle, emitPrisma, emitSql } from './rls-emit.ts';
import { fieldViews, rowBranches } from './rls-fields.ts';
import { roleNames } from './rls-grants.ts';
import { closureDepths, graphPlan, graphSql } from './rls-graph.ts';
import { helpersSql } from './rls-helpers.ts';
import { ownershipRules, ownershipSql } from './rls-ownership.ts';
import { assemblePolicies } from './rls-policies.ts';
import { type RbacAuthorizeMode, rbacScaffold } from './rls-rbac.ts';
import {
  checkSuspension,
  graphHelper,
  parseMembershipsFlag,
  scopeTable,
} from './rls-sql.ts';

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

/** Declared role names, and those a tenant admin may compose into custom roles. */
function customRoleNames(policy: Policy): {
  readonly declared: readonly string[];
  readonly assignable: readonly string[];
} {
  const declared = [...roleNames(policy)].toSorted();
  const assignable = declared.filter(
    (name) =>
      policy.rolesByName.get(name)?.assignable ??
      listRoles(policy.vocabulary.roles).some(
        (leaf) => leaf.key === name && leaf.assignable,
      ),
  );
  return { declared, assignable };
}

function defaultAuthorize(
  rbac: boolean,
  memberships: RlsMemberships | undefined,
): RbacAuthorizeMode {
  if (rbac) {
    return 'database';
  }
  return memberships?.tenant !== undefined ||
    memberships?.team !== undefined ||
    Object.keys(memberships?.scopes ?? {}).length > 0
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
  readonly policyPerRole?: boolean;
  readonly policyName?: string;
  readonly tenantType?: string;
  readonly customRoles?: boolean;
  readonly capabilities?: boolean;
  readonly fields?: string;
  readonly revokeColumns?: boolean;
  readonly io: CliIo;
}): Promise<GenerateOutcome> {
  const rls = input.config.rls;
  const fieldsMode = input.fields ?? rls?.fields;
  if (fieldsMode !== undefined && fieldsMode !== 'views') {
    return {
      code: 2,
      output: `rls generate --fields must be views (got ${fieldsMode})`,
      text: '',
    };
  }
  const revokeColumns =
    input.revokeColumns === true || rls?.revokeColumns === true;
  if (revokeColumns && fieldsMode === undefined) {
    return {
      code: 2,
      output: 'rls generate --revoke-columns needs --fields views',
      text: '',
    };
  }
  const policy = await loadPolicy(input.cwd, input.config, input.from);
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
  const scopes = scopeList(policy.scopes);
  const suspension = checkSuspension(rls?.suspension, scopes);
  const ownership = ownershipRules(policy, scopes);
  const graph = graphPlan(policy);
  const ctx: RlsSqlContext = {
    dialect: input.dialect,
    scopes,
    tenantClaim: rls?.tenantClaim ?? supabaseTenantClaim,
    gucPrefix: input.gucPrefix ?? rls?.gucPrefix ?? 'app',
    inlineFunctions: input.inlineFunctions || rls?.inlineFunctions === true,
    schema,
    authorize,
    roleClaim: rls?.roleClaim ?? 'user_role',
    tenantType: input.tenantType ?? rls?.tenantType ?? 'uuid',
    ...(rls?.teamType === undefined ? {} : { teamType: rls.teamType }),
    ...(rls?.scopeTypes === undefined ? {} : { scopeTypes: rls.scopeTypes }),
    ...(memberships === undefined ? {} : { memberships }),
    ...(suspension === undefined ? {} : { suspension }),
    ...(input.customRoles === true || rls?.customRoles === true
      ? { customRoles: customRoleNames(policy) }
      : {}),
    ...(input.capabilities === true || rls?.capabilities === true
      ? { capabilities: true as const }
      : {}),
    ...(ownership === undefined ? {} : { ownership }),
    ...(fieldsMode === undefined ? {} : { fields: fieldsMode }),
    ...(graph.size === 0 ? {} : { graph: { closures: closureDepths(graph) } }),
  };
  const warnings: string[] = [];
  if (authorize === 'database') {
    for (const { name } of ctx.scopes) {
      const needs = policy.grants.some((grant) => grant.scope === name);
      if (needs && scopeTable(ctx, name) === undefined) {
        warnings.push(
          `${name}-scoped grants read the ${name} memberships table in database mode: set rls.memberships.scopes.${name} (or --memberships for the first scope), otherwise they deny`,
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
  const views =
    fieldsMode === undefined
      ? []
      : fieldViews(policy, ctx, compiled.branches, { revokeColumns }, warnings);
  const force = input.force === true || rls?.force === true;
  if (force && views.some((view) => view.companion !== undefined)) {
    warnings.push(
      '--force with --revoke-columns: each <table>_visible_fields companion reads as its owner, so its owner needs BYPASSRLS or the restricted columns read as null',
    );
  }
  const policyName = input.policyName ?? rls?.policyName;
  const policies = assemblePolicies(
    fieldsMode === undefined
      ? compiled.branches
      : rowBranches(compiled.branches),
    {
      perRole: input.policyPerRole === true || rls?.policyPerRole === true,
      ...(policyName === undefined ? {} : { name: policyName }),
    },
  );
  const rootMapped =
    ctx.scopes[0] === undefined
      ? undefined
      : scopeTable(ctx, ctx.scopes[0].name);
  const rootTable =
    rootMapped === undefined
      ? undefined
      : { ...rootMapped.table, tenant: rootMapped.column };
  const rbac = input.rbac
    ? rbacScaffold(policy, {
        schema,
        authorize,
        ...(rootTable === undefined ? {} : { memberships: rootTable }),
        ...(ctx.scopes[0] === undefined ? {} : { scope: ctx.scopes[0].name }),
        ...(ctx.customRoles === undefined
          ? {}
          : { customRoles: { declared: ctx.customRoles.declared } }),
        context: ctx,
      })
    : undefined;
  if (rbac !== undefined) {
    warnings.push(...rbac.warnings);
  }
  if (input.rbac) {
    warnings.push(
      'the token hook that writes user_role and memberships comes from permdock supabase hook generate',
    );
  }
  const owned = ownershipSql(ctx);
  const graphed = graphSql(ctx, graph, rls?.tables);
  const breakGlass = breakGlassSql(ctx, breakGlassEntries(policy, rls?.tables));
  const preamble = [
    rbac?.head,
    helpersSql(ctx, compiled.rolePermissions, {
      userRoles: !input.rbac,
      anonExecute: views.some((view) => view.roles.includes('anon')),
    }),
    owned === '' ? undefined : owned,
    graphed === '' ? undefined : graphed,
    breakGlass === '' ? undefined : breakGlass,
    rbac?.tail,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n');
  if (force) {
    for (const entry of graph.values()) {
      const own = [...entry.relations].filter(
        (name) => !('edge' in (entry.node.relations[name] ?? {})),
      );
      if (own.length > 0) {
        warnings.push(
          `--force: ${entry.node.name} relations ${own.join(', ')} are read from the ${entry.node.name} table itself, so ${graphHelper(entry.node.name)} would recurse through its own policy; keep ${entry.node.name} unforced or move them to edge tables`,
        );
      }
    }
  }
  if (force && input.target !== 'sql') {
    warnings.push(
      `--force: ${input.target} has no FORCE ROW LEVEL SECURITY option; run the commented statements in a migration`,
    );
  }
  let text: string;
  switch (input.target) {
    case 'sql':
      text = emitSql(policies, preamble, force, views);
      break;
    case 'drizzle':
      text = emitDrizzle(policies, preamble, force, views);
      break;
    case 'prisma':
      text = emitPrisma(policies, preamble, force, views);
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
