import type {
  AuthorizationFunctions,
  AuthorizationRequirement,
} from "better-supabase/contract";

import type {
  SupabaseManifest,
  SupabaseManifestMembership,
} from "../supabase/manifest.ts";

import { quoteSqlLiteral, sqlIdent } from "../core/sql.ts";

export type PortalInput = {
  readonly manifest: SupabaseManifest;
  readonly tenantScope: string;
  readonly requires: AuthorizationRequirement[];
  readonly problems: string[];
};

type Portal = Pick<
  AuthorizationFunctions,
  "teamIdsOf" | "portalSubjects" | "portalParties"
>;

const union = (selects: readonly string[]): string | undefined =>
  selects.length === 0 ? undefined : `(${selects.join(" union ")})`;

/** A scope directly within the tenant scope and its membership sources. */
type ChildScope = {
  readonly name: string;
  readonly sources: readonly SupabaseManifestMembership[];
};

function childScopes(
  manifest: SupabaseManifest,
  tenantScope: string,
): readonly ChildScope[] {
  return manifest.rls.scopes
    .filter((scope) => scope.within === tenantScope)
    .map((scope) => ({
      name: scope.name,
      sources: manifest.rls.memberships.filter(
        (source) =>
          "value" in source.scope && source.scope.value === scope.name,
      ),
    }))
    .filter((scope) => scope.sources.length > 0);
}

/** The source row's tenant id as text, from its `within` ancestor ids. */
function tenantOf(
  source: SupabaseManifestMembership,
  tenantScope: string,
): string | undefined {
  const within = source.within;
  if (within === undefined) return undefined;
  if ("column" in within) {
    return `(m.${sqlIdent(within.column)} ->> ${quoteSqlLiteral(tenantScope)})`;
  }
  const column = within.columns[tenantScope];
  return column === undefined ? undefined : `m.${sqlIdent(column)}::text`;
}

/**
 * better-supabase's `teamIdsOf`, `portalSubjects` and `portalParties` from the
 * scopes directly within the tenant scope. A child scope whose memberships have
 * no `via` is the team scope when it is the only one; a child scope whose
 * memberships all name `via` is a portal scope, whose members are guests of the
 * tenant the membership row names. Every template reads the caller-bound
 * `member_<scope>_ids()`, so it answers for the signed-in user only.
 */
export function portalFunctionsOf(input: PortalInput): Portal {
  const { manifest, tenantScope, requires, problems } = input;
  const schema = sqlIdent(manifest.rls.schema);
  const helpers = new Set(manifest.rls.helpers.map((helper) => helper.name));
  const children = childScopes(manifest, tenantScope).filter((scope) =>
    helpers.has(`member_${scope.name}_ids`),
  );
  const memberIds = (scope: string): string => {
    const fn = `${schema}.${sqlIdent(`member_${scope}_ids`)}`;
    if (!requires.some((entry) => entry.function === fn)) {
      requires.push({ function: fn, role: "authenticated" });
    }
    return `${fn}()`;
  };

  const teams = children.filter((scope) =>
    scope.sources.every((source) => source.via === undefined),
  );
  if (teams.length > 1) {
    problems.push(
      `teamIdsOf: the scopes ${teams.map((scope) => scope.name).join(", ")} are all within ${tenantScope} without via, so none is taken as the team scope. Name the team scope team or teams.`,
    );
  }
  const [team] = teams;
  const teamIdsOf =
    team === undefined || teams.length > 1
      ? undefined
      : `(select m.id from ${memberIds(team.name)} as m(id) where {user} = (select auth.uid()))`;

  const parties: string[] = [];
  const subjects: string[] = [];
  for (const scope of children) {
    if (!scope.sources.every((source) => source.via !== undefined)) continue;
    const permitted = helpers.has(`permitted_${scope.name}_ids`);
    for (const source of scope.sources) {
      const tenant = tenantOf(source, tenantScope);
      if (tenant === undefined) {
        problems.push(
          `${source.table} names no ${tenantScope} column in within, so portalParties and portalSubjects leave out its ${scope.name} guests.`,
        );
        continue;
      }
      const id = `m.${sqlIdent(source.id.column)}`;
      const select = `select ${tenant}, ${quoteSqlLiteral(scope.name)}, ${id}::text from ${source.table} m where ${id} in (select ${memberIds(scope.name)})`;
      parties.push(select);
      if (permitted) {
        const fn = `${schema}.${sqlIdent(`permitted_${scope.name}_ids_by_permission`)}`;
        if (!requires.some((entry) => entry.function === fn)) {
          requires.push({ function: fn, args: "text", role: "authenticated" });
        }
        subjects.push(
          `${select} and ${id} in (select ${fn}(${quoteSqlLiteral(`${scope.name}.`)} || {action}))`,
        );
      }
    }
  }
  const portalParties = union(parties);
  const portalSubjects = union(subjects);
  return {
    ...(teamIdsOf === undefined ? {} : { teamIdsOf }),
    ...(portalSubjects === undefined ? {} : { portalSubjects }),
    ...(portalParties === undefined ? {} : { portalParties }),
  };
}
