export type CollectConfig = {
  readonly srcPath?: readonly string[];
  readonly out?: string;
  readonly barrel?: boolean | string;
};

export type CatalogConfig = {
  readonly out?: string;
};

export type RlsDialect = 'supabase' | 'neon' | 'guc';

export type RlsTarget = 'sql' | 'drizzle' | 'prisma';

export type RlsMembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
  readonly tenant?: string;
  readonly team?: string;
  readonly id?: string;
  readonly expiresAt?: string;
};

export type RlsMemberships = {
  readonly tenant?: RlsMembershipTable;
  readonly team?: RlsMembershipTable;
  readonly resource?: Readonly<Record<string, RlsMembershipTable>>;
};

export type RlsFunctionMapping = {
  readonly twin: unknown;
  readonly args?: readonly string[];
};

export type RlsConfig = {
  readonly tables?: Readonly<Record<string, string>>;
  readonly dialect?: RlsDialect;
  readonly memberships?: RlsMemberships;
  readonly functions?: Readonly<Record<string, RlsFunctionMapping>>;
  readonly inlineFunctions?: boolean;
  readonly fixtures?: string;
  readonly tenantClaim?: string;
  readonly roleClaim?: string;
  readonly gucPrefix?: string;
  readonly out?: string;
};

export type DoctorConfig = {
  readonly sensitiveActions?: readonly string[];
  readonly memberships?: string;
};

export type PermDockConfig = {
  readonly permissions?: string;
  readonly policy?: string;
  readonly collect?: CollectConfig;
  readonly catalog?: CatalogConfig;
  readonly openapi?: {
    readonly doc?: readonly string[];
  };
  readonly rls?: RlsConfig;
  readonly doctor?: DoctorConfig;
};

export type CatalogUsage = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
};

export type CatalogPermission = {
  readonly key: string;
  readonly scope: string;
  readonly resource: string;
  readonly action: string;
  readonly arity: 'instance' | 'collection';
  readonly meta: Readonly<Record<string, unknown>>;
  readonly usages: readonly CatalogUsage[];
};

export type CatalogResource = {
  readonly id: string;
  readonly schema: unknown;
  readonly definedIn?: string;
  readonly relations?: Readonly<
    Record<string, { readonly field: string; readonly memberOf?: string }>
  >;
};

export type CatalogDocument = {
  readonly $schema: string;
  readonly version: 1 | 2;
  readonly generatedAt: string;
  readonly generator: string;
  readonly resources: Readonly<Record<string, CatalogResource>>;
  readonly permissions: readonly CatalogPermission[];
  readonly roles?: readonly { readonly key: string }[];
  readonly plans?: readonly { readonly key: string }[];
};

export type DynamicUsage = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
};

export type ScanResult = {
  readonly roots: readonly string[];
  readonly definitionFiles: Readonly<Record<string, string>>;
  readonly usages: Readonly<Record<string, readonly CatalogUsage[]>>;
  readonly unknown: readonly CatalogUsage[];
  readonly dynamic: readonly DynamicUsage[];
  readonly roleNames: readonly string[];
  readonly planNames: readonly string[];
  readonly allowKeys: readonly string[];
};

export type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
};

export type RunResult = {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
};

export type CreatePermDockPluginOptions = {
  readonly collect?: CollectConfig;
  readonly onDrift?: 'error' | 'warn';
};
