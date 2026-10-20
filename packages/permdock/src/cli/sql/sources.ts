import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { PermDockConfig } from "../types.ts";

/**
 * The membership sources a project reads: `rls.membershipSources`, else
 * `supabase.hook.memberships`. Every generator, doctor check and verifier
 * resolves them here, so they all read the same tables.
 */
export function membershipSourcesOf(
  config: PermDockConfig,
): readonly SqlMembershipSource[] {
  return (
    config.rls?.membershipSources ?? config.supabase?.hook?.memberships ?? []
  );
}
