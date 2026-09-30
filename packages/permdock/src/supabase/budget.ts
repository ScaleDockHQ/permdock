/** The default size budget, in bytes of JSON, for the hook's `memberships` claim: about 15 UUID-keyed single-role memberships. */
export const supabaseMembershipsBudget = 1024;

/**
 * The default claim that carries the active first-scope id: the hook writes
 * it, `subjectFromSupabase` reads it, and the RLS helpers compare with it.
 * `rls.tenantClaim` and the `tenant` option change it.
 */
export const supabaseTenantClaim = 'tenant_id';
