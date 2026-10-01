import type { Principal } from 'permdock';

import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from 'permdock';
import { z } from 'zod';

/**
 * The CentraKit shape: staff hold one role per organization in `memberships`,
 * and a portal contact holds `contact` on their customer through `contacts.user_id`.
 */
const Staff = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  user_id: z.uuid(),
  name: z.string(),
  title: z.string(),
});

const Quote = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  customer_id: z.uuid(),
  title: z.string(),
  amount: z.number(),
});

export const permissions = definePermissions({
  staff: resource(Staff, {
    id: 'id',
    actions: ['read'],
    collection: ['list'],
    relations: {
      organization: { field: 'organization_id', memberOf: 'organization' },
    },
  }),
  quotes: resource(Quote, {
    id: 'id',
    actions: ['read'],
    collection: ['list'],
    relations: {
      organization: { field: 'organization_id', memberOf: 'organization' },
      customer: { field: 'customer_id', memberOf: 'customer' },
    },
  }),
});

export const roles = defineRoles({
  owner: { on: 'organization' },
  member: { on: 'organization' },
  contact: { on: 'customer', assignable: false },
});

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      organization: { key: 'organization_id' },
      customer: { key: 'customer_id', within: 'organization' },
    },
    // The loaders pass a full Subject from `subjectFromSupabaseSession`, which skips this mapper.
    subject: (user: Principal | null) => user,
    roles: [
      role(
        roles.owner,
        [
          allow([
            permissions.staff.read,
            permissions.staff.list,
            permissions.quotes.read,
            permissions.quotes.list,
          ]),
        ],
        { on: 'organization', min: 1 },
      ),
      role(
        roles.member,
        [allow([permissions.staff.read, permissions.staff.list])],
        { on: 'organization' },
      ),
      role(
        roles.contact,
        [allow([permissions.quotes.read, permissions.quotes.list])],
        { on: 'customer', min: 0 },
      ),
    ],
  },
);
