import type { GenerateContext } from "./generate-context.ts";
import type {
  GenerateOptions,
  Refusal,
  RlsGenerateInput,
} from "./generate-options.ts";

import { compact } from "../../core/compact.ts";
import { policyRowConditionKeys } from "../../core/row-conditions.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { type Policy, listPermissions } from "../../index.ts";
import { describeError } from "../core/errors.ts";
import {
  type CompiledGrants,
  type CompiledPolicy,
  compileGrants,
} from "../sql/compile.ts";
import { scopeSources, scopeTable } from "../sql/names.ts";
import { qualified, quoteLiteral } from "../sql/quote.ts";
import { subjectClaimJsonSql } from "../sql/subject.ts";
import { policySql } from "./emit.ts";
import { type FieldView, fieldViews, rowBranches } from "./fields.ts";
import {
  ACTOR_MAY_WRITE,
  assemblePolicies,
  readOnlyActorKinds,
  readOnlyActorPolicies,
} from "./policies.ts";
import { realtimeStoragePolicies } from "./realtime-storage.ts";
import { inheritTargets } from "./rows.ts";

export type GeneratedPolicies = {
  readonly compiled: CompiledGrants;
  readonly helpersOnly: boolean;
  readonly force: boolean;
  readonly views: readonly FieldView[];
  /** The table policies, with the read-only actor policies over them. */
  readonly policies: readonly CompiledPolicy[];
  /** The `realtime.messages` and `storage.objects` policies. */
  readonly helperTables?: string;
  /** `helperTables` with each policy guarded by its table, for pg-delta. */
  readonly guardedTables?: string;
};

const SERVICE_TABLES_HEADER =
  "-- Supabase Realtime and Storage: rls.realtime and rls.storage. RLS on both tables is Supabase's.";

/**
 * A `realtime.messages` or `storage.objects` policy that applies only where
 * the table exists. The Realtime and Storage services create those tables, so
 * a local stack with the service off, and pg-delta's shadow database, have
 * none.
 */
function guardedPolicySql(item: CompiledPolicy): string {
  const body = policySql(item)
    .trimEnd()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `do $permdock$
begin
  if to_regclass(${quoteLiteral(qualifySqlTable(item.table))}) is not null then
${body}
  end if;
end
$permdock$;
`;
}

/** Appends the `realtime.messages` and `storage.objects` policies, which never get `tableSql`. */
export function withHelperTables(
  sql: string,
  helperTables: string | undefined,
): string {
  if (helperTables === undefined) {
    return sql;
  }
  const tables = `${helperTables.trimEnd()}\n`;
  return sql.trim() === "" ? tables : `${sql.trimEnd()}\n\n${tables}`;
}

function databaseModeWarnings(
  policy: Policy,
  { ctx }: GenerateContext,
  warnings: string[],
): void {
  if (ctx.authorize !== "database") {
    return;
  }
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

/** The grants compiled into table policies, and the Realtime and Storage policies beside them. */
export function generatePolicies(
  input: RlsGenerateInput,
  policy: Policy,
  options: GenerateOptions,
  built: GenerateContext,
  warnings: string[],
): GeneratedPolicies | Refusal {
  const rls = input.config.rls;
  const { ctx } = built;
  const { fieldsMode, revokeColumns } = options;
  databaseModeWarnings(policy, built, warnings);
  const compiled = compileGrants(
    policy,
    ctx,
    rls?.tables,
    warnings,
    input.skipClosures,
    rls?.rowHelpers !== undefined || inheritTargets(policy).length > 0,
  );
  const helpersOnly = input.helpersOnly === true || rls?.helpersOnly === true;
  if (helpersOnly && (input.target !== "sql" || revokeColumns)) {
    return {
      refusal:
        "rls generate --helpers-only needs --target sql and no --revoke-columns: the table grants are hand-written, so revoke the restricted columns there",
    };
  }
  const views =
    fieldsMode === undefined
      ? []
      : fieldViews(
          policy,
          ctx,
          compiled.branches,
          { revokeColumns, helpersOnly },
          warnings,
        );
  const force = input.force === true || rls?.force === true;
  if (force && views.some((view) => view.companion !== undefined)) {
    warnings.push(
      "--force with --revoke-columns: each <table>_visible_fields companion reads as its owner, so its owner needs BYPASSRLS or the restricted columns read as null",
    );
  }
  const policyName = input.policyName ?? rls?.policyName;
  const assembled = helpersOnly
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
  const actorKinds = readOnlyActorKinds(rls?.readOnlyActors);
  if (actorKinds !== undefined && helpersOnly) {
    warnings.push(
      `rls.readOnlyActors with --helpers-only writes no policies: add \`and (select ${qualified(ctx, ACTOR_MAY_WRITE)}())\` to each hand-written insert, update and delete policy, or a restrictive policy that calls it`,
    );
  }
  const withActors = (
    items: readonly CompiledPolicy[],
  ): readonly CompiledPolicy[] =>
    actorKinds === undefined
      ? items
      : [
          ...items,
          ...readOnlyActorPolicies(
            items,
            subjectClaimJsonSql(ctx, "act"),
            actorKinds,
          ),
        ];
  let tablePolicies: readonly CompiledPolicy[];
  try {
    tablePolicies = realtimeStoragePolicies(
      ctx,
      {
        scopes: new Set(ctx.scopes.map((scope) => scope.name)),
        keys: new Set(
          listPermissions(policy.vocabulary.permissions).map(
            (leaf) => leaf.key,
          ),
        ),
        rowConditions: new Set(policyRowConditionKeys(policy)),
      },
      compact({ realtime: rls?.realtime, storage: rls?.storage }),
      warnings,
    );
  } catch (cause) {
    return { refusal: describeError(cause) };
  }
  if (tablePolicies.length > 0 && helpersOnly) {
    warnings.push(
      "rls.realtime and rls.storage add policies, and --helpers-only writes none: no realtime.messages or storage.objects policy is written",
    );
  }
  const servicePolicies =
    tablePolicies.length === 0 || helpersOnly ? [] : withActors(tablePolicies);
  const generated = {
    compiled,
    helpersOnly,
    force,
    views,
    policies: withActors(assembled),
  };
  if (servicePolicies.length === 0) {
    return generated;
  }
  return {
    ...generated,
    helperTables: [
      SERVICE_TABLES_HEADER,
      ...servicePolicies.map(policySql),
    ].join("\n"),
    guardedTables: [
      `${SERVICE_TABLES_HEADER} A stack without the service has no table, so each policy is skipped there.`,
      ...servicePolicies.map(guardedPolicySql),
    ].join("\n"),
  };
}
