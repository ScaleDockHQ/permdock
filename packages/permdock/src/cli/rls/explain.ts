import type { RlsSqlContext } from "../sql/context.ts";
import type { PermDockConfig } from "../types.ts";
import type { TableBinding } from "./bindings.ts";
import type { GeneratedPolicies } from "./generate-policies.ts";
import type { GeneratedTrigger } from "./trigger-notes.ts";

import { tableNames } from "../sql/tables.ts";
import { tableBindings } from "./bindings.ts";
import { generatedTriggers } from "./trigger-notes.ts";

/**
 * What `permdock rls explain` reports: how the generated SQL binds to the
 * application's schema.
 */
export type RlsExplain = {
  readonly schema: string;
  readonly authorize: string;
  readonly scopes: readonly {
    readonly name: string;
    readonly key: string;
    readonly within?: string;
  }[];
  /**
   * The table each resource's policies target; `exists` is set with
   * `--db-url-stdin`.
   */
  readonly bindings: readonly (TableBinding & {
    readonly exists?: boolean;
    /**
     * `rls.tables` `via`: the helper the policies call and the parent column it
     * reads.
     */
    readonly via?: string;
  })[];
  readonly membershipSources: readonly {
    readonly table: string;
    /**
     * The generated `select` of one user's memberships, with the role SQL as
     * the helpers read it.
     */
    readonly select: string;
  }[];
  readonly customRoles?: {
    readonly table: string;
    readonly key: string;
    readonly tenant?: string;
    readonly shared?: string;
    readonly skip?: string;
    /** Which kinds of role the table holds: `tenant`, `shared` or `global`. */
    readonly holds: readonly ("tenant" | "shared" | "global")[];
  };
  readonly rowHelpers: readonly {
    readonly resource: string;
    /** The permission keys the helper decides for the resource's rows. */
    readonly permissions: readonly string[];
  }[];
  readonly triggers: readonly GeneratedTrigger[];
};

type ExplainInput = {
  readonly config: PermDockConfig;
  readonly ctx: RlsSqlContext;
  readonly schema: string;
  readonly authorize: string;
  readonly generated: GeneratedPolicies;
  readonly text: string;
};

function holds(
  table: NonNullable<
    NonNullable<NonNullable<PermDockConfig["rls"]>["customRoleWrites"]>["roles"]
  >,
): readonly ("tenant" | "shared" | "global")[] {
  if (table.tenant === undefined) {
    return ["global"];
  }
  return [
    "tenant",
    ...(table.shared === undefined ? [] : (["shared"] as const)),
    "global",
  ];
}

export function explainRls(input: ExplainInput): RlsExplain {
  const { config, ctx, generated } = input;
  const rls = config.rls;
  const bindings = tableBindings(
    generated.compiled.rowColumns.map((item) => item.resource),
    tableNames(rls?.tables),
    generated.helpersOnly,
  );
  const sources = ctx.memberSources ?? ctx.sources ?? [];
  const roles = rls?.customRoleWrites?.roles;
  const wanted = rls?.rowHelpers;
  const resources =
    wanted === undefined
      ? []
      : wanted === true
        ? [
            ...new Set(
              generated.compiled.branches.flatMap((branch) =>
                branch.resource === undefined ? [] : [branch.resource],
              ),
            ),
          ].toSorted()
        : [...new Set(wanted)];
  return {
    schema: input.schema,
    authorize: input.authorize,
    scopes: ctx.scopes.map((scope) =>
      scope.within === undefined
        ? { name: scope.name, key: scope.key ?? scope.name }
        : {
            name: scope.name,
            key: scope.key ?? scope.name,
            within: scope.within,
          },
    ),
    bindings: bindings.map((binding) => {
      const via = ctx.vias?.[binding.resource];
      return via === undefined
        ? binding
        : Object.assign({}, binding, {
            via: `${via.helper} over ${via.table}.${via.column} (${binding.table}.${via.key})`,
          });
    }),
    membershipSources: sources.map((source) => ({
      table: source.sql.table,
      select: source.sql.select("$1"),
    })),
    ...(roles === undefined
      ? {}
      : {
          customRoles: {
            table: roles.table,
            key: roles.key,
            ...(roles.tenant === undefined ? {} : { tenant: roles.tenant }),
            ...(roles.shared === undefined ? {} : { shared: roles.shared }),
            ...(roles.skip === undefined ? {} : { skip: roles.skip }),
            holds: holds(roles),
          },
        }),
    rowHelpers: resources.map((resource) => ({
      resource,
      permissions: [
        ...new Set(
          generated.compiled.branches.flatMap((branch) =>
            branch.resource === resource && branch.coverage !== true
              ? [branch.permissionKey]
              : [],
          ),
        ),
      ].toSorted(),
    })),
    triggers: generatedTriggers(input.text),
  };
}

/** The text report of `explain`. */
export function describeExplain(explain: RlsExplain): string {
  const lines: string[] = [
    `schema ${explain.schema}, authorize ${explain.authorize}`,
    `scopes: ${explain.scopes.map((scope) => `${scope.name} (${scope.key}${scope.within === undefined ? "" : `, within ${scope.within}`})`).join(", ")}`,
    "",
    "table bindings:",
    ...explain.bindings.map(
      (binding) =>
        `  ${binding.resource} -> ${binding.table}${binding.inferred ? " (named after the resource; set rls.tables to change)" : ""}${binding.via === undefined ? "" : ` via ${binding.via}`}${binding.exists === false ? " MISSING" : ""}`,
    ),
  ];
  if (explain.membershipSources.length > 0) {
    lines.push("", "membership sources:");
    for (const source of explain.membershipSources) {
      lines.push(
        `  ${source.table}`,
        `    ${source.select.replaceAll("\n", "\n    ")}`,
      );
    }
  }
  if (explain.customRoles !== undefined) {
    const roles = explain.customRoles;
    const columns = [
      `key ${roles.key}`,
      ...(roles.tenant === undefined ? [] : [`tenant ${roles.tenant}`]),
      ...(roles.shared === undefined ? [] : [`shared ${roles.shared}`]),
      ...(roles.skip === undefined ? [] : [`skip ${roles.skip}`]),
    ];
    lines.push(
      "",
      `custom roles: ${roles.table} (${columns.join(", ")}); holds ${roles.holds.join(", ")} roles`,
    );
  }
  if (explain.rowHelpers.length > 0) {
    lines.push("", "row helpers:");
    for (const helper of explain.rowHelpers) {
      lines.push(`  ${helper.resource}: ${helper.permissions.join(", ")}`);
    }
  }
  if (explain.triggers.length > 0) {
    lines.push("", "generated triggers:");
    for (const trigger of explain.triggers) {
      lines.push(`  ${trigger.name} on ${trigger.table} (${trigger.reason})`);
    }
  }
  return lines.join("\n");
}
