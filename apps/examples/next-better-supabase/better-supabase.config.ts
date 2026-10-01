import { defineConfig } from 'better-supabase/config';

/** Membership and PermDock tables stay off the Data API: only the token hook and the security definer helpers read them. */
const internal = [
  'memberships',
  'contacts',
  'customers',
  'organization_features',
  'user_roles',
  'role_permissions',
  'permdock_authz_version',
] as const;

export default defineConfig({
  output: 'src/lib/supabase/generated.ts',
  expose: {
    organizations: { anon: ['select'], authenticated: ['select'] },
    staff: ['select'],
    quotes: ['select'],
    datetime_preferences: ['select'],
    ...Object.fromEntries(internal.map((table) => [table, []])),
  },
});
