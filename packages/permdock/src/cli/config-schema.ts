import type {
  CatalogConfig,
  CollectConfig,
  DoctorConfig,
  PermDockConfig,
  PowerSyncConfig,
  RlsConfig,
  SupabaseConfig,
} from "./types.ts";

import { CliError } from "./errors.ts";

type Section = Exclude<keyof PermDockConfig, "permissions" | "policy">;

const COLLECT = {
  srcPath: true,
  out: true,
  barrel: true,
} as const satisfies Record<keyof CollectConfig, true>;

const CATALOG = { out: true } as const satisfies Record<
  keyof CatalogConfig,
  true
>;

const OPENAPI = { doc: true } as const satisfies Record<
  keyof NonNullable<PermDockConfig["openapi"]>,
  true
>;

const RLS = {
  tables: true,
  dialect: true,
  memberships: true,
  membershipSources: true,
  suspension: true,
  functions: true,
  inlineFunctions: true,
  force: true,
  fixtures: true,
  tenantClaim: true,
  tenantType: true,
  teamType: true,
  scopeTypes: true,
  roleClaim: true,
  gucPrefix: true,
  out: true,
  drizzle: true,
  prisma: true,
  schema: true,
  authorize: true,
  policyPerRole: true,
  customRoles: true,
  capabilities: true,
  anonymousSignIns: true,
  fields: true,
  revokeColumns: true,
  policyName: true,
  rbac: true,
  roles: true,
  actions: true,
  helpersOnly: true,
  migrate: true,
  shims: true,
  tenants: true,
  customRoleWrites: true,
  anonExecute: true,
  assignments: true,
  approvals: true,
  jsonSchema: true,
  ownershipTriggers: true,
  readOnlyActors: true,
  apiKeys: true,
  realtime: true,
  storage: true,
} as const satisfies Record<keyof RlsConfig, true>;

const SUPABASE = { hook: true } as const satisfies Record<
  keyof SupabaseConfig,
  true
>;

const POWERSYNC = {
  out: true,
  resources: true,
  action: true,
} as const satisfies Record<keyof PowerSyncConfig, true>;

const DOCTOR = {
  sensitiveActions: true,
  memberships: true,
  credentials: true,
  clientEntries: true,
  migrations: true,
  claims: true,
  srcPath: true,
} as const satisfies Record<keyof DoctorConfig, true>;

const SECTIONS: Readonly<Record<Section, Readonly<Record<string, true>>>> = {
  collect: COLLECT,
  catalog: CATALOG,
  openapi: OPENAPI,
  rls: RLS,
  supabase: SUPABASE,
  powersync: POWERSYNC,
  doctor: DOCTOR,
};

const TOP_LEVEL = new Set<string>([
  "permissions",
  "policy",
  ...Object.keys(SECTIONS),
]);

export type ParsedConfig = {
  readonly config: PermDockConfig;
  /** Keys PermDock does not read, as `path: message`; a typo lands here. */
  readonly warnings: readonly string[];
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSection(key: string): key is Section {
  return Object.hasOwn(SECTIONS, key);
}

/**
 * Checks the shape a command relies on before it reads the config: module
 * paths are strings and each section is an object. A key PermDock does not
 * read is a warning, so a config written for a newer version still loads.
 */
export function parseConfig(value: unknown, file: string): ParsedConfig {
  if (value === undefined) {
    return { config: {}, warnings: [] };
  }
  if (!isRecord(value)) {
    throw new CliError(
      "usage",
      `PermDock CLI: ${file} must export a config object as default (use defineConfig)`,
    );
  }
  const warnings: string[] = [];
  const unknown = (path: string, known: Iterable<string>): string =>
    `${file}: unknown key ${path}; PermDock reads ${[...known].join(", ")}`;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "permissions" || key === "policy") {
      if (entry !== undefined && typeof entry !== "string") {
        throw new CliError(
          "usage",
          `PermDock CLI: ${file}: ${key} must be a module path string`,
        );
      }
      continue;
    }
    if (!isSection(key)) {
      warnings.push(unknown(key, TOP_LEVEL));
      continue;
    }
    if (entry === undefined) {
      continue;
    }
    if (!isRecord(entry)) {
      throw new CliError(
        "usage",
        `PermDock CLI: ${file}: ${key} must be an object`,
      );
    }
    const known = SECTIONS[key];
    for (const child of Object.keys(entry)) {
      if (!Object.hasOwn(known, child)) {
        warnings.push(unknown(`${key}.${child}`, Object.keys(known)));
      }
    }
  }
  // SAFETY: the module paths and section shapes were checked above; section values are the project's to type with defineConfig.
  return { config: value as PermDockConfig, warnings };
}
