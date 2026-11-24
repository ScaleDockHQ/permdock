import type { Seeds } from "../core/seeds.ts";
import type { PowerSyncConfig } from "./types-powersync.ts";
import type { RlsConfig } from "./types-rls.ts";
import type { SupabaseConfig } from "./types-supabase.ts";

export type CollectConfig = {
  readonly srcPath?: readonly string[];
  readonly out?: string;
  readonly barrel?: boolean | string;
};

export type CatalogConfig = { readonly out?: string };

export type DoctorConfig = {
  /**
   * Directories or globs the source checks read (PD001, PD002, PD007 to PD015,
   * PD044 and the other checks over files), default `collect.srcPath`. The
   * catalog `collect` writes still comes from `collect.srcPath`, and PD004
   * compares the catalog on disk with that one.
   */
  readonly srcPath?: readonly string[];
  readonly sensitiveActions?: readonly string[];
  readonly memberships?: string;
  /**
   * A JSON fixture `{ credentials?, settings? }` of API-key credentials and
   * per-tenant settings (the `memorySettingsSource` input) for PD029.
   */
  readonly credentials?: string;
  /**
   * Globs or directories whose files are client entries for PD001, for
   * frameworks with no `'use client'` convention.
   */
  readonly clientEntries?: readonly string[];
  /**
   * Globs or directories of SQL migrations PD022 scans for views; defaults to
   * the usual migration folders.
   */
  readonly migrations?: readonly string[];
  /**
   * A JSON array of sample decoded token claims; PD039 measures each
   * `supabase.hook.claims` entry in it.
   */
  readonly claims?: string;
  /**
   * Functions that build an object once and keep it; PD080 and PD081 skip a
   * factory call passed to one of them, as in `once(() => claimsFirst(...))`.
   */
  readonly cacheHelpers?: readonly string[];
  /**
   * A JSON file of accepted findings, relative to the project root, in
   * better-supabase's grouped form `[{ code, reason, targets }]`. Every entry
   * needs a reason, an entry that matches no finding is an error, and `permdock
   * doctor --update-baseline` rewrites it.
   */
  readonly baseline?: string;
  /** The lowest severity that exits 1; default `error`. `--fail-on` wins. */
  readonly failOn?: "error" | "warning";
  /**
   * PD131 reports a table with more than `max` policies for one command and
   * `authenticated`; default 4, better-supabase's `doctor.policies.max`.
   */
  readonly policies?: { readonly max?: number };
};

/**
 * Byte budgets, in bytes of JSON. `permdock generate --check` and doctor PD132
 * fail over one.
 */
export type BudgetsConfig = {
  /** `clientBundle(policy)`, the module `permdock gen --kind bundle` writes. */
  readonly bundle?: number;
  /**
   * The snapshot of the role with the most grants, holding `memberships`
   * memberships (default 3).
   */
  readonly snapshot?: { readonly bytes: number; readonly memberships?: number };
  /**
   * The `memberships` claim of a user with `snapshot.memberships` memberships
   * of one role each.
   */
  readonly claims?: number;
};

export type PermDockConfig = {
  readonly permissions?: string;
  readonly policy?: string;
  /**
   * A module exporting the `defineOperations` map as `operations` or default;
   * `collect` writes it to the catalog's `operations`.
   */
  readonly operations?: string;
  readonly collect?: CollectConfig;
  readonly catalog?: CatalogConfig;
  readonly openapi?: {
    readonly doc?: readonly string[];
    /**
     * `"<module>#<export>"` of an `operationPermissions(...)` result (the
     * export defaults to `operations`); `permdock doctor` checks it against
     * `doc` (PD091).
     */
    readonly operations?: string;
    /** Path templates whose operations need an entry, such as `/orgs/{orgId}`. */
    readonly tenantPaths?: readonly string[];
    /** A prefix the documents' paths carry and the `operations` keys do not. */
    readonly base?: string;
    /**
     * `"kernel"` checks coverage against the operations the kernel enforces and
     * leaves out those marked `x-permdock-enforcement: handler`.
     */
    readonly enforcement?: "kernel";
  };
  readonly rls?: RlsConfig;
  /**
   * Where better-supabase's config lives, when it is not found from
   * `permdock.config.ts` up to the workspace root.
   */
  readonly betterSupabase?: { readonly config?: string };
  readonly supabase?: SupabaseConfig;
  readonly powersync?: PowerSyncConfig;
  readonly doctor?: DoctorConfig;
  readonly gen?: GenConfig;
  readonly budgets?: BudgetsConfig;
  /**
   * Generate plugins, in `definePlugin` order. `after` reorders them. An empty
   * list writes the core outputs only.
   */
  readonly plugins?: readonly unknown[];
  /**
   * `defineSeeds` output. Defaults become a data migration. Fixtures become
   * `supabase/seeds/permdock.sql`. `rls.seeds` still chooses `'function'` or
   * `'view'` for the compiled `role_permissions` rows.
   */
  readonly seeds?: Seeds;
};

/** What `permdock gen --kind` writes. */
export type GenKind =
  | "zod"
  | "valibot"
  | "arktype"
  | "json-schema"
  | "standard-schema"
  | "constants"
  | "types"
  | "sql"
  | "factories"
  | "react"
  | "vue"
  | "svelte"
  | "solid"
  | "messages"
  | "bundle";

/** `permdock gen` input. */
export type GenConfig = {
  /** The directory the generated files go to; default `src/permdock`. */
  readonly out?: string;
  /**
   * The kinds `permdock gen` writes without `--kind`; default `['constants',
   * 'types', 'sql']`. `zod`, `valibot` and `factories` add `types`, which they
   * import.
   */
  readonly kinds?: readonly GenKind[];
  /**
   * Also write `fields.ts`: `<resource>Fields` per resource, with each field's
   * `label`, `required`, enum `options` and bounds, for forms. A form page
   * imports it; a validator page does not.
   */
  readonly fields?: boolean;
  /** Zod output settings. */
  readonly zod?: {
    /** `zod/mini` writes the functional, tree-shakeable API; default `zod`. */
    readonly specifier?: "zod" | "zod/mini";
  };
};
