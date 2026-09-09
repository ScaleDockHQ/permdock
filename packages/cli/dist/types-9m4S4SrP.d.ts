//#region src/types.d.ts
type CollectConfig = {
  readonly srcPath?: readonly string[];
  readonly out?: string;
  readonly barrel?: boolean | string;
};
type CatalogConfig = {
  readonly out?: string;
};
type RlsDialect = "supabase" | "neon" | "guc";
type RlsTarget = "sql" | "drizzle" | "prisma";
type RlsMembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
  readonly tenant?: string;
  readonly team?: string;
  readonly id?: string;
  readonly expiresAt?: string;
};
type RlsMemberships = {
  readonly tenant?: RlsMembershipTable;
  readonly team?: RlsMembershipTable;
  readonly resource?: Readonly<Record<string, RlsMembershipTable>>;
};
type RlsConfig = {
  readonly tables?: Readonly<Record<string, string>>;
  readonly dialect?: RlsDialect;
  readonly memberships?: RlsMemberships;
  readonly tenantClaim?: string;
  readonly roleClaim?: string;
  readonly gucPrefix?: string;
  readonly out?: string;
};
type PermDockConfig = {
  readonly permissions?: string;
  readonly policy?: string;
  readonly collect?: CollectConfig;
  readonly catalog?: CatalogConfig;
  readonly openapi?: {
    readonly doc?: readonly string[];
  };
  readonly rls?: RlsConfig;
};
type CatalogUsage = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
};
type CatalogPermission = {
  readonly key: string;
  readonly scope: string;
  readonly resource: string;
  readonly action: string;
  readonly arity: "instance" | "collection";
  readonly meta: Readonly<Record<string, unknown>>;
  readonly usages: readonly CatalogUsage[];
};
type CatalogResource = {
  readonly id: string;
  readonly schema: unknown;
  readonly definedIn?: string;
};
type CatalogDocument = {
  readonly $schema: string;
  readonly version: 1;
  readonly generatedAt: string;
  readonly generator: string;
  readonly resources: Readonly<Record<string, CatalogResource>>;
  readonly permissions: readonly CatalogPermission[];
};
type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
};
type RunResult = {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
};
type CreatePermDockPluginOptions = {
  readonly collect?: CollectConfig;
  readonly onDrift?: "error" | "warn";
};
//#endregion
export { CreatePermDockPluginOptions as a, RlsDialect as c, RlsTarget as d, RunResult as f, CollectConfig as i, RlsMembershipTable as l, CatalogDocument as n, PermDockConfig as o, CliIo as r, RlsConfig as s, CatalogConfig as t, RlsMemberships as u };