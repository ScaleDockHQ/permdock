import type { SqlConnect } from "../pg.ts";
import type {
  CliIo,
  PermDockConfig,
  RlsDialect,
  RlsTarget,
  SupabaseSchemas,
} from "../types.ts";
import type { RbacAuthorizeMode } from "./rbac.ts";

import { type SplitPart, parseSplit } from "../output-files.ts";

export type RlsGenerateInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly target: RlsTarget;
  readonly dialect: RlsDialect;
  readonly out?: string;
  readonly from?: string;
  /** `--project`: rebuild the policy with `policyFromCatalog` from the Cloud project's pushed catalog and policy. */
  readonly project?: string;
  /** The Cloud API base URL `project` is read from. */
  readonly url?: string;
  readonly json?: boolean;
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
  /** `--split helpers,seeds,policies,hook`: one file per part, `{part}` in `out` naming it. */
  readonly split?: string;
  /** `--schemas`; default from `resolveSchemas`. */
  readonly schemas?: SupabaseSchemas;
  /** migra only: the privileges `supabase db diff` drops go here (`-` prints them); needs the `helpers` or `hook` part. */
  readonly grantsOut?: string;
  /**
   * The `seeds` part goes here instead of `{part}` in `out` (`-` prints it), so
   * it can be a versioned migration. A directory (ending in `/`, or existing)
   * gets a new `<version>_permdock_seeds.sql` only when the rows changed.
   */
  readonly seedsOut?: string;
  /**
   * The `rls.customRoles.from` copy goes here (`-` prints it). A directory
   * gets a new `<version>_permdock_backfill.sql` only when the copy changed.
   */
  readonly backfillOut?: string;
  /** Only the helpers, their seeds and the scaffold: no table policies, for a project whose policies are hand-written. */
  readonly helpersOnly?: boolean;
  /** Legacy-named wrappers over the helpers, one per `rls.migrate.helpers` entry. */
  readonly shims?: boolean;
  /** `false` returns the SQL and its policies without touching `out`. */
  readonly write?: boolean;
  /** `--db`: index suggestions leave out what the database already indexes or lacks. */
  readonly db?: string;
  readonly connect?: SqlConnect;
  readonly io: CliIo;
};

/** A flag or config combination `rls generate` refuses with exit code 2. */
export type Refusal = { readonly refusal: string };

export function isRefusal(value: object): value is Refusal {
  return "refusal" in value;
}

export type GenerateOptions = {
  readonly fieldsMode: "views" | undefined;
  readonly revokeColumns: boolean;
};

/** The checks that need no policy: `--fields` and `--revoke-columns`. */
export function generateOptions(
  input: RlsGenerateInput,
): GenerateOptions | Refusal {
  const rls = input.config.rls;
  const fieldsMode = input.fields ?? rls?.fields;
  if (fieldsMode !== undefined && fieldsMode !== "views") {
    return {
      refusal: `rls generate --fields must be views (got ${fieldsMode})`,
    };
  }
  const revokeColumns =
    input.revokeColumns === true || rls?.revokeColumns === true;
  if (revokeColumns && fieldsMode === undefined) {
    return { refusal: "rls generate --revoke-columns needs --fields views" };
  }
  return { fieldsMode, revokeColumns };
}

/** Whether `--split` names `part`, which then leaves the helpers or the warnings. */
export function splitsPart(raw: string | undefined, part: SplitPart): boolean {
  const split = parseSplit(raw);
  return typeof split !== "string" && split?.includes(part) === true;
}
