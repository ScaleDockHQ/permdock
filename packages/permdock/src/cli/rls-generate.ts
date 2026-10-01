import { basename, resolve } from 'node:path';

import type { Policy } from '../index.ts';
import type { CompiledPolicy } from './rls-compile.ts';
import type { RolePermission } from './rls-helpers.ts';
import type { RlsSqlContext } from './rls-sql.ts';
import type {
  CliIo,
  PermDockConfig,
  RlsDialect,
  RlsMemberships,
  RlsTarget,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { scopeList } from '../core/scopes.ts';
import { listPermissions, listRoles } from '../index.ts';
import { supabaseTenantClaim } from '../supabase/budget.ts';
import { policyRowConditionKeys } from './catalog-doc.ts';
import { asPolicy, loadModule, pickNamed } from './load.ts';
import { breakGlassEntries, breakGlassSql } from './rls-break-glass.ts';
import { compileGrants } from './rls-compile.ts';
import {
  defaultOut,
  emitDrizzle,
  emitPrisma,
  emitSql,
  migrationOut,
  migrationSql,
} from './rls-emit.ts';
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
  scopeSources,
  scopeTable,
} from './rls-sql.ts';
import {
  driftOf,
  parseSplit,
  partPath,
  type SqlFile,
  writeSqlFiles,
} from './sql-files.ts';
import { grantsLabel, supabaseHookSql } from './supabase-hook.ts';

export type GenerateOutcome = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
  readonly text: string;
  /** The policies `text` creates; set when `write` is false. */
  readonly policies?: readonly CompiledPolicy[];
  /** For Drizzle and Prisma, the SQL written next to `text` for a custom migration. */
  readonly migration?: string;
  /** The seeded `role_permissions` rows and the policy's keys; set when `write` is false. */
  readonly seeds?: readonly RolePermission[];
  readonly keys?: {
    readonly permissions: readonly string[];
    readonly rowConditions: readonly string[];
  };
  readonly schema?: string;
  readonly helpersOnly?: boolean;
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
  /** `--split helpers,policies,hook`: one file per part, `{part}` in `out` naming it. */
  readonly split?: string;
  /** The hook's `supabase_auth_admin` grants go here (`-` prints them); needs the `hook` part. */
  readonly grantsOut?: string;
  /** Only the helpers, their seeds and the scaffold: no table policies, for a project whose policies are hand-written. */
  readonly helpersOnly?: boolean;
  /** `false` returns the SQL and its policies without touching `out`. */
  readonly write?: boolean;
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
    (rls?.membershipSources === undefined
      ? defaultAuthorize(input.rbac, memberships)
      : 'database');
  const sources =
    authorize === 'database'
      ? (rls?.membershipSources ?? input.config.supabase?.hook?.memberships)
      : undefined;
  const scopes = scopeList(policy.scopes);
  const suspension = checkSuspension(rls?.suspension, scopes);
  const hookRoles = input.config.supabase?.hook?.roles;
  const roles = rls?.roles ?? (hookRoles === false ? undefined : hookRoles);
  if (roles !== undefined && input.rbac) {
    return {
      code: 2,
      output:
        'rls generate --rbac supabase creates its own user_roles (user_id, role app_role); drop rls.roles (or supabase.hook.roles) or the --rbac flag',
      text: '',
    };
  }
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
    ...(sources === undefined || sources.length === 0 ? {} : { sources }),
    ...(suspension === undefined ? {} : { suspension }),
    ...(roles === undefined ? {} : { roles }),
    ...(input.customRoles === true || rls?.customRoles === true
      ? { customRoles: customRoleNames(policy) }
      : {}),
    ...(input.capabilities === true || rls?.capabilities === true
      ? { capabilities: true as const }
      : {}),
    ...(ownership === undefined ? {} : { ownership }),
    ...(fieldsMode === undefined ? {} : { fields: fieldsMode }),
    ...(graph.size === 0
      ? {}
      : {
          graph: {
            closures: closureDepths(graph),
            resources: policy.resources,
            ...(rls?.tables === undefined ? {} : { tables: rls.tables }),
          },
        }),
  };
  const warnings: string[] = [];
  if (authorize === 'database') {
    for (const { name } of ctx.scopes) {
      const needs = policy.grants.some((grant) => grant.scope === name);
      if (
        needs &&
        scopeTable(ctx, name) === undefined &&
        scopeSources(ctx, name).length === 0
      ) {
        warnings.push(
          `${name}-scoped grants read the ${name} memberships table in database mode: set rls.memberships.scopes.${name}, rls.membershipSources or supabase.hook.memberships (or --memberships for the first scope), otherwise they deny`,
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
  const helpersOnly = input.helpersOnly === true || rls?.helpersOnly === true;
  if (helpersOnly && (input.target !== 'sql' || fieldsMode !== undefined)) {
    return {
      code: 2,
      output: 'rls generate --helpers-only needs --target sql and no --fields',
      text: '',
    };
  }
  const policies = helpersOnly
    ? []
    : assemblePolicies(
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
  const outRel = input.out ?? rls?.out ?? defaultOut(input.target);
  const migration =
    input.target === 'sql'
      ? ''
      : migrationSql(policies, preamble, force, views);
  const migrationRel = migration === '' ? undefined : migrationOut(outRel);
  const helpers =
    migrationRel === undefined ? undefined : basename(migrationRel);
  let text: string;
  switch (input.target) {
    case 'sql':
      text = emitSql(policies, preamble, force, views);
      break;
    case 'drizzle':
      text = emitDrizzle(
        policies,
        compact({
          dialect: ctx.dialect,
          schema: rls?.drizzle?.schema,
          exports: rls?.drizzle?.exports,
          helpers,
        }),
      );
      break;
    case 'prisma':
      text = emitPrisma(
        policies,
        compact({ models: rls?.prisma?.models, helpers }),
      );
      break;
    default: {
      const exhaustive: never = input.target;
      return exhaustive;
    }
  }
  for (const column of compiled.filtered) {
    warnings.push(`index suggestion: create index on ${column}`);
  }
  const extras = migration === '' ? {} : { migration };
  if (input.write === false) {
    return {
      code: 0,
      output: warnings.join('\n'),
      text,
      policies,
      seeds: compiled.rolePermissions,
      keys: {
        permissions: listPermissions(policy.vocabulary.permissions).map(
          (leaf) => leaf.key,
        ),
        rowConditions: [...policyRowConditionKeys(policy)],
      },
      schema,
      helpersOnly,
      ...extras,
    };
  }
  const planned = outputFiles({
    input,
    outRel,
    text,
    helpersOnly,
    sql: () => ({
      policies: emitSql(policies, '', force, views),
      helpers: emitSql([], preamble),
    }),
    scopes,
  });
  if (typeof planned === 'string') {
    return { code: 2, output: planned, text, ...extras };
  }
  const files: SqlFile[] = [...planned];
  if (migrationRel !== undefined) {
    files.push({ part: 'migration', rel: migrationRel, text: migration });
  }
  if (input.check) {
    const drift = driftOf(input.cwd, files);
    return drift.length === 0
      ? { code: 0, output: 'rls generate up to date', text, ...extras }
      : {
          code: 1,
          output: drift.map((line) => `rls generate drift: ${line}`).join('\n'),
          text,
          ...extras,
        };
  }
  const written = writeSqlFiles(input.cwd, files);
  const extra = warnings.length === 0 ? '' : `\n${warnings.join('\n')}`;
  return {
    code: 0,
    output: `wrote ${written.wrote.join(', ')}${written.printed === '' ? '' : `\n${written.printed}`}${extra}`,
    text,
    ...extras,
  };
}

/** The files `generate` writes: one, or one per `--split` part, plus the hook's grants. */
function outputFiles(plan: {
  readonly input: Parameters<typeof runRlsGenerate>[0];
  readonly outRel: string;
  readonly text: string;
  readonly helpersOnly: boolean;
  readonly sql: () => { readonly policies: string; readonly helpers: string };
  readonly scopes: ReturnType<typeof scopeList>;
}): readonly SqlFile[] | string {
  const { input, outRel } = plan;
  const split = parseSplit(input.split);
  if (typeof split === 'string') {
    return split;
  }
  if (split?.includes('policies') === true && plan.helpersOnly) {
    return 'rls generate --helpers-only writes no policies part; drop it from --split';
  }
  if (split === undefined) {
    if (input.grantsOut !== undefined) {
      return "rls generate --grants-out needs --split with the hook part: the grants are the token hook's";
    }
    return [{ part: 'rls', rel: outRel, text: plan.text }];
  }
  if (input.target !== 'sql') {
    return 'rls generate --split needs --target sql';
  }
  if (!outRel.includes('{part}')) {
    return `rls generate --split needs {part} in --out, for example supabase/schemas/identity/056_permdock_{part}.sql (got ${outRel})`;
  }
  if (input.grantsOut !== undefined && !split.includes('hook')) {
    return 'rls generate --grants-out needs the hook part in --split';
  }
  if (split.includes('hook') && input.config.supabase?.hook === undefined) {
    return 'rls generate --split hook needs supabase.hook in permdock.config.ts';
  }
  const sql = plan.sql();
  const files: SqlFile[] = [];
  for (const part of split) {
    switch (part) {
      case 'helpers':
        files.push({ part, rel: partPath(outRel, part), text: sql.helpers });
        break;
      case 'policies':
        files.push({ part, rel: partPath(outRel, part), text: sql.policies });
        break;
      case 'hook': {
        const hook = supabaseHookSql(
          plan.scopes,
          input.config,
          {},
          grantsLabel(input.grantsOut),
        );
        files.push({ part, rel: partPath(outRel, part), text: hook.sql });
        if (input.grantsOut !== undefined) {
          files.push({
            part: 'grants',
            rel: input.grantsOut,
            text: hook.grants,
          });
        }
        break;
      }
      default: {
        const exhaustive: never = part;
        return exhaustive;
      }
    }
  }
  return files;
}
