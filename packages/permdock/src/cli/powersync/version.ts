import type { PermDockConfig } from "../types.ts";

import {
  AUTHZ_VERSION_TABLE,
  PERMDOCK_SCHEMA,
} from "../../supabase/sources.ts";

/** The user column of `permdock_authz_version`. */
export const VERSION_USER = "user_id";

/** The version column of `permdock_authz_version`. */
export const VERSION_COLUMN = "version";

/**
 * `<schema>.permdock_authz_version` when `supabase.hook` keeps the version
 * table, the one `supabase hook generate` writes; otherwise `undefined`.
 */
export function authzVersionTable(config: PermDockConfig): string | undefined {
  const hook = config.supabase?.hook;
  if (hook === undefined || hook.version === false) {
    return undefined;
  }
  const schema = hook.schema ?? config.rls?.schema ?? PERMDOCK_SCHEMA;
  return `${schema}.${AUTHZ_VERSION_TABLE}`;
}
