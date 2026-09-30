import type { SqlQuery } from 'permdock/supabase';

import { fromJunction } from 'permdock/supabase';

/** better-supabase's organization membership table, in its own schema. */
export function membership(query?: SqlQuery) {
  return fromJunction({
    table: 'better_supabase.memberships',
    scope: 'organization',
    id: 'org_id',
    roles: 'role',
    ...(query === undefined ? {} : { query }),
  });
}
