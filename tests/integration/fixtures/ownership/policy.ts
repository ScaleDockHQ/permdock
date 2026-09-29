import type { Principal } from 'permdock';

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from 'permdock';
import { z } from 'zod';

/** One primary owner per organization that only moves by transfer, and at most two approvers. */
export const permissions = definePermissions({
  payment: resource(z.object({ id: z.string(), org_id: z.string() }), {
    id: 'id',
    actions: ['read', 'approve'],
    relations: { org: { field: 'org_id', memberOf: 'org' } },
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { org: { key: 'org_id' } },
  subject: (user: Principal | null) => user,
  roles: [
    role('primary', [allow(permissions.payment.approve)], {
      on: 'org',
      min: 1,
      max: 1,
      transferOnly: true,
      assigns: ['primary', 'approver'],
    }),
    role('approver', [allow(permissions.payment.read)], { on: 'org', max: 2 }),
  ],
});
