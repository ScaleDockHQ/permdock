import type {
  RlsConfig,
  RlsDialect,
  RlsTarget,
  SupabaseSchemas,
} from "../../types.ts";

/**
 * `rls.seeds` as a mode, or `false` to skip the rows, or where they are
 * written.
 */
type RlsSeedsOption =
  | "function"
  | "view"
  | false
  | {
      readonly mode?: "function" | "view";
      readonly out?: string;
      readonly backfill?: string;
    };

/**
 * Options for `rls()`. `out`, `split`, `target` and `schemas` replace the
 * generate flags of those names. `seeds: false` replaces `--no-seeds`. `seeds:
 * { out, backfill }` replaces `--seeds-out` and `--backfill-out`.
 */
export type RlsPluginOptions = Omit<RlsConfig, "seeds"> & {
  readonly target?: RlsTarget;
  readonly schemas?: SupabaseSchemas;
  readonly seeds?: RlsSeedsOption;
  readonly grantsOut?: string;
  /** `--rbac supabase`: scaffold the role tables. */
  readonly rbacScaffold?: "supabase";
  /** `--tenant-type`: the tenant id type the helpers take. */
  readonly tenantType?: string;
};

export type AppliedRlsPlugin = {
  readonly config: RlsConfig;
  readonly target: RlsTarget;
  readonly dialect: RlsDialect | undefined;
  readonly out: string | undefined;
  readonly split: string | undefined;
  readonly schemas: SupabaseSchemas | undefined;
  readonly seedsOut: string | undefined;
  readonly backfillOut: string | undefined;
  readonly noSeeds: boolean;
  readonly grantsOut: string | undefined;
  readonly rbac: boolean;
  readonly tenantType: string | undefined;
};

function seedMode(
  seeds: RlsSeedsOption | undefined,
): "function" | "view" | undefined {
  if (seeds === "function" || seeds === "view") {
    return seeds;
  }
  if (seeds !== undefined && seeds !== false && seeds.mode !== undefined) {
    return seeds.mode;
  }
  return undefined;
}

function seedFile(
  seeds: RlsSeedsOption | undefined,
  field: "out" | "backfill",
): string | undefined {
  if (seeds === undefined || seeds === false || typeof seeds === "string") {
    return undefined;
  }
  return seeds[field];
}

/** The config and generate inputs `options` add over `base`. */
export function applyRlsPlugin(
  base: RlsConfig | undefined,
  options: RlsPluginOptions,
): AppliedRlsPlugin {
  const {
    target,
    schemas,
    seeds,
    grantsOut,
    rbacScaffold,
    tenantType,
    out,
    split,
    dialect,
    ...rest
  } = options;
  const mode = seedMode(seeds);
  const source: RlsConfig = base ?? {};
  const { seeds: baseSeeds, ...baseRest } = source;
  const kept =
    seeds === false
      ? {}
      : mode === undefined
        ? baseSeeds === undefined
          ? {}
          : { seeds: baseSeeds }
        : { seeds: mode };
  return {
    config: {
      ...baseRest,
      ...rest,
      ...(dialect === undefined ? {} : { dialect }),
      ...(split === undefined ? {} : { split }),
      ...kept,
    },
    target: target ?? "sql",
    dialect: dialect ?? base?.dialect,
    out: out ?? base?.out,
    split: (split ?? base?.split)?.join(","),
    schemas,
    seedsOut: seedFile(seeds, "out"),
    backfillOut: seedFile(seeds, "backfill"),
    noSeeds: seeds === false,
    grantsOut,
    rbac: rbacScaffold === "supabase",
    tenantType,
  };
}
