import type {
  CatalogConfig,
  CollectConfig,
  DoctorConfig,
  PermDockConfig,
  PowerSyncConfig,
  RlsConfig,
  SupabaseConfig,
} from "../types.ts";

/** The JavaScript kinds a config value may take; `object` excludes arrays. */
export type ValueKind =
  | "string"
  | "boolean"
  | "number"
  | "array"
  | "object"
  | "function";

export type KeyShape = readonly ValueKind[];

const STRING = ["string"] as const satisfies KeyShape;
const BOOLEAN = ["boolean"] as const satisfies KeyShape;
const ARRAY = ["array"] as const satisfies KeyShape;
const OBJECT = ["object"] as const satisfies KeyShape;
const BOOLEAN_OR_OBJECT = ["boolean", "object"] as const satisfies KeyShape;
const BOOLEAN_OR_ARRAY = ["boolean", "array"] as const satisfies KeyShape;
const BOOLEAN_OR_STRING = ["boolean", "string"] as const satisfies KeyShape;

const MODULE = ["string", "object"] as const satisfies KeyShape;

const COLLECT = {
  srcPath: ARRAY,
  out: STRING,
  barrel: BOOLEAN_OR_STRING,
} as const satisfies Record<keyof CollectConfig, KeyShape>;

const CATALOG = { out: STRING } as const satisfies Record<
  keyof CatalogConfig,
  KeyShape
>;

const OPENAPI = { doc: ARRAY } as const satisfies Record<
  keyof NonNullable<PermDockConfig["openapi"]>,
  KeyShape
>;

const RLS = {
  tables: OBJECT,
  dialect: STRING,
  memberships: OBJECT,
  membershipSources: ARRAY,
  suspension: OBJECT,
  functions: OBJECT,
  inlineFunctions: BOOLEAN,
  force: BOOLEAN,
  fixtures: STRING,
  verify: OBJECT,
  tenantClaim: STRING,
  tenantType: STRING,
  teamType: STRING,
  scopeTypes: OBJECT,
  roleClaim: STRING,
  roleValues: OBJECT,
  gucPrefix: STRING,
  out: STRING,
  drizzle: OBJECT,
  prisma: OBJECT,
  schema: STRING,
  authorize: STRING,
  policyPerRole: BOOLEAN,
  customRoles: BOOLEAN_OR_OBJECT,
  triggers: OBJECT,
  audit: OBJECT,
  capabilities: BOOLEAN,
  anonymousSignIns: STRING,
  fields: STRING,
  revokeColumns: BOOLEAN,
  policyName: STRING,
  rbac: OBJECT,
  roles: OBJECT,
  actions: OBJECT,
  helpersOnly: BOOLEAN,
  rowHelpers: BOOLEAN_OR_ARRAY,
  seeds: STRING,
  treeValues: OBJECT,
  trustedReaders: ARRAY,
  migrate: OBJECT,
  shims: BOOLEAN_OR_OBJECT,
  tenants: STRING,
  customRoleWrites: OBJECT,
  anonExecute: BOOLEAN,
  assignments: BOOLEAN_OR_OBJECT,
  approvals: BOOLEAN_OR_OBJECT,
  jsonSchema: BOOLEAN_OR_STRING,
  ownershipTriggers: BOOLEAN_OR_OBJECT,
  readOnlyActors: BOOLEAN_OR_ARRAY,
  apiKeys: BOOLEAN_OR_OBJECT,
  tokenScopes: BOOLEAN,
  realtime: OBJECT,
  storage: OBJECT,
} as const satisfies Record<keyof RlsConfig, KeyShape>;

const SUPABASE = { hook: OBJECT, schemas: STRING } as const satisfies Record<
  keyof SupabaseConfig,
  KeyShape
>;

const POWERSYNC = {
  out: STRING,
  resources: ARRAY,
  action: STRING,
  manifest: STRING,
} as const satisfies Record<keyof PowerSyncConfig, KeyShape>;

const DOCTOR = {
  sensitiveActions: ARRAY,
  memberships: STRING,
  credentials: STRING,
  clientEntries: ARRAY,
  migrations: ARRAY,
  claims: STRING,
  srcPath: ARRAY,
  sharedTables: ARRAY,
} as const satisfies Record<keyof DoctorConfig, KeyShape>;

export type Section = Exclude<
  keyof PermDockConfig,
  "permissions" | "policy" | "operations"
>;

export type ModuleKey = "permissions" | "policy" | "operations";

/**
 * Every key PermDock reads, per section, with the kinds its value may take.
 * `satisfies` ties each list to `keyof` its section type, so a new option
 * cannot ship without the validator knowing it.
 */
export const CONFIG_SHAPE: Readonly<
  Record<Section, Readonly<Record<string, KeyShape>>>
> = {
  collect: COLLECT,
  catalog: CATALOG,
  openapi: OPENAPI,
  rls: RLS,
  supabase: SUPABASE,
  powersync: POWERSYNC,
  doctor: DOCTOR,
};

export const MODULE_KEYS: Readonly<Record<ModuleKey, KeyShape>> = {
  permissions: MODULE,
  policy: MODULE,
  operations: MODULE,
};

export function isSection(key: string): key is Section {
  return Object.hasOwn(CONFIG_SHAPE, key);
}

export function isModuleKey(key: string): key is ModuleKey {
  return Object.hasOwn(MODULE_KEYS, key);
}

export function kindOf(value: unknown): ValueKind | undefined {
  if (Array.isArray(value)) {
    return "array";
  }
  const type = typeof value;
  switch (type) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "function":
      return "function";
    case "object":
      return value === null ? undefined : "object";
    case "bigint":
    case "symbol":
    case "undefined":
      return undefined;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

export function describeKinds(kinds: KeyShape): string {
  const names = kinds.map((kind) =>
    kind === "array"
      ? "an array"
      : kind === "object"
        ? "an object"
        : `a ${kind}`,
  );
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;
}
