import { membership } from './sources.ts';

export default {
  permissions: '../named-scopes/policy.ts',
  policy: '../named-scopes/policy.ts',
  supabase: { hook: { memberships: [membership()], roles: false } },
};
