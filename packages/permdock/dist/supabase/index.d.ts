import { d as Subject, u as Principal } from "../subject-BcgWbogX.js";
import { StandardSchemaV1 } from "@standard-schema/spec";
//#region src/supabase/types.d.ts
type SupabasePrincipal = Principal & {
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly email?: string;
  readonly phone?: string;
  readonly is_anonymous?: boolean;
};
type SupabaseInclude = "email" | "phone" | "is_anonymous";
type SupabaseMembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
  readonly tenant?: string;
  readonly team?: string;
  readonly id?: string;
  readonly expiresAt?: string;
};
type SupabaseRlsOptions = {
  readonly roleClaim?: string;
  readonly tenantClaim?: string;
  readonly memberships?: SupabaseMembershipTable | {
    readonly tenant?: SupabaseMembershipTable;
    readonly team?: SupabaseMembershipTable;
    readonly resource?: Readonly<Record<string, SupabaseMembershipTable>>;
  };
};
type SupabaseRlsConfig = {
  readonly dialect: "supabase";
  readonly roleClaim: string;
  readonly tenantClaim: string;
  readonly memberships?: {
    readonly tenant?: SupabaseMembershipTable;
    readonly team?: SupabaseMembershipTable;
    readonly resource?: Readonly<Record<string, SupabaseMembershipTable>>;
  };
};
type SupabaseSubjectOptions = {
  readonly roles?: string;
  readonly tenant?: string;
  readonly memberships?: string;
  readonly schema?: StandardSchemaV1;
  readonly include?: readonly SupabaseInclude[];
  readonly declared?: readonly string[];
};
//#endregion
//#region src/supabase/rls.d.ts
export declare function supabaseRls(options?: SupabaseRlsOptions): SupabaseRlsConfig;
export declare function authorizeSql(options?: {
  readonly tenant?: boolean;
}): string;
//#endregion
//#region src/supabase/subject.d.ts
export declare function subjectFromSupabase(claims: unknown, options?: SupabaseSubjectOptions): Subject<SupabasePrincipal>;
//#endregion
export type { SupabaseInclude, SupabaseMembershipTable, SupabasePrincipal, SupabaseRlsConfig, SupabaseRlsOptions, SupabaseSubjectOptions };