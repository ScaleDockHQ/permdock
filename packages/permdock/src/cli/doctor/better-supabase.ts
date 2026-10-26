import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { BetterSupabaseActiveTenant } from "../../better-supabase/active-tenant.ts";
import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { activeTenantMismatch } from "../../better-supabase/active-tenant.ts";
import { parseCatalog } from "../../catalog/parse.ts";
import { isRecord } from "../../core/compact.ts";
import { rootScope, scopeList } from "../../core/scopes.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { catalogPath } from "../catalog-path.ts";
import { rel } from "../files.ts";
import {
  betterSupabaseConfig,
  betterSupabaseDefaults,
} from "../project/better-supabase.ts";
import { filesOf } from "../shared/doctor-files.ts";
import { activeSource } from "../supabase-hook/memberships.ts";
import { policyOf } from "./inputs.ts";

function activeTenantOf(
  config: Record<string, unknown>,
): BetterSupabaseActiveTenant | undefined {
  const blocks = config["blocks"];
  const permissions = isRecord(blocks) ? blocks["permissions"] : undefined;
  const value = isRecord(permissions) ? permissions["activeTenant"] : undefined;
  if (value === "claim" || value === "resolver") {
    return value;
  }
  if (isRecord(value) && typeof value["profileColumn"] === "string") {
    const key = value["key"];
    return {
      profileColumn: value["profileColumn"],
      ...(typeof key === "string" ? { key } : {}),
    };
  }
  return undefined;
}

/**
 * PermDock's token hook reads the active tenant from another place than
 * better-supabase's `blocks.permissions.activeTenant` writes it, so
 * `switch_organization` never changes the tenant claim.
 */
export async function pd078(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const hook = input.config.supabase?.hook;
  if (hook === undefined) {
    return [];
  }
  const config = await betterSupabaseConfig(input);
  const activeTenant =
    config === undefined ? undefined : activeTenantOf(config);
  if (activeTenant === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  const root =
    policy === undefined ? undefined : rootScope(scopeList(policy.scopes));
  let from: ReturnType<typeof activeSource>;
  try {
    from = activeSource(
      betterSupabaseDefaults(input.config, config !== undefined).supabase?.hook
        ?.activeFrom,
      root ?? "tenant",
    );
  } catch {
    return [];
  }
  const mismatch = activeTenantMismatch(
    from,
    input.config.rls?.tenantClaim ?? supabaseTenantClaim,
    activeTenant,
  );
  return mismatch === undefined
    ? []
    : [
        {
          code: "PD078",
          severity: "warning",
          message: mismatch,
          fix: "set supabase.hook.activeFrom, then run permdock supabase hook generate",
        },
      ];
}

type BlockPermissionKey = {
  readonly module: string;
  readonly action: string;
  readonly key: string;
};

function isBlockPermissionKey(value: unknown): value is BlockPermissionKey {
  return (
    isRecord(value) &&
    typeof value["module"] === "string" &&
    typeof value["action"] === "string" &&
    typeof value["key"] === "string"
  );
}

/**
 * Every permission key the configured blocks check, from the project's own
 * `better-supabase/sql`; `undefined` when it does not resolve or refuses the
 * config.
 */
async function blockPermissionKeys(
  cwd: string,
  blocks: Record<string, unknown>,
): Promise<readonly BlockPermissionKey[] | undefined> {
  try {
    const file = createRequire(resolve(cwd, "package.json")).resolve(
      "better-supabase/sql",
    );
    // Optional peer: only a project with a better-supabase config reaches it.
    const sql: Record<string, unknown> = await import(pathToFileURL(file).href);
    const list = sql["modulePermissionKeys"];
    if (!isKeyLister(list)) {
      return undefined;
    }
    const keys: unknown = list(blocks, Object.keys(blocks));
    return Array.isArray(keys) ? keys.filter(isBlockPermissionKey) : undefined;
  } catch {
    return undefined;
  }
}

function isKeyLister(
  value: unknown,
): value is (blocks: unknown, names: readonly string[]) => unknown {
  return typeof value === "function";
}

/**
 * A permission key a configured better-supabase block checks that the catalog
 * does not list: no role holds it, so the block's SQL checks deny it.
 */
export async function pd079(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const config = await betterSupabaseConfig(input);
  const blocks = config?.["blocks"];
  if (!isRecord(blocks)) {
    return [];
  }
  const files = filesOf(input);
  const path = catalogPath(input.config, input.cwd);
  if (!files.exists(path)) {
    return [];
  }
  let declared: ReadonlySet<string>;
  try {
    declared = new Set(
      parseCatalog(files.read(path)).permissions.map(({ key }) => key),
    );
  } catch {
    return [];
  }
  const keys = await blockPermissionKeys(input.cwd, blocks);
  if (keys === undefined) {
    return [];
  }
  const missing = new Map<string, string[]>();
  for (const entry of keys) {
    if (!declared.has(entry.key)) {
      const uses = missing.get(entry.key) ?? [];
      uses.push(`blocks.${entry.module}.permissions.${entry.action}`);
      missing.set(entry.key, uses);
    }
  }
  const catalog = rel(input.cwd, path);
  return [...missing].map(([key, uses]): DoctorFinding => ({
    code: "PD079",
    severity: "warning",
    message: `${key} (${[...new Set(uses)].join(", ")}) is not in ${catalog}, so no role holds it and better-supabase's SQL check denies it`,
    fix: `declare ${key} in the policy and run permdock collect, or map the block action to a key the catalog lists`,
  }));
}
