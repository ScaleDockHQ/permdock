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
 * CentraKit's target model: staff hold one role per organization through
 * `memberships`, portal contacts hold `contact` on their customer through
 * `contacts.user_id`, and platform roles live in `user_roles`.
 */
const Customer = z.object({ id: z.uuid(), organization_id: z.uuid() });

const Quote = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  customer_id: z.uuid(),
});

const Organization = z.object({ id: z.uuid() });

export const permissions = definePermissions({
  customers: resource(Customer, {
    id: 'id',
    actions: ['read', 'update'],
    relations: {
      organization: { field: 'organization_id', memberOf: 'organization' },
    },
  }),
  quotes: resource(Quote, {
    id: 'id',
    actions: ['read', 'update'],
    relations: {
      organization: { field: 'organization_id', memberOf: 'organization' },
      customer: { field: 'customer_id', memberOf: 'customer' },
    },
  }),
  organizations: resource(Organization, {
    id: 'id',
    actions: ['read', 'update'],
  }),
});

export const roles = defineRoles({
  owner: { on: 'organization', assignable: false },
  admin: { on: 'organization' },
  member: { on: 'organization' },
  viewer: { on: 'organization' },
  contact: { on: 'customer', assignable: false },
  'platform-admin': {},
});

const staff = { for: ['staff'] } as const;

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      organization: { key: 'organization_id' },
      customer: { key: 'customer_id', within: 'organization' },
    },
    subject: (user: Principal | null) => user,
    roles: [
      role(
        roles.owner,
        [
          allow([
            permissions.customers.read,
            permissions.customers.update,
            permissions.quotes.read,
            permissions.quotes.update,
          ]),
        ],
        { on: 'organization', ...staff },
      ),
      role(
        roles.admin,
        [
          allow([
            permissions.customers.read,
            permissions.customers.update,
            permissions.quotes.read,
            permissions.quotes.update,
          ]),
        ],
        { on: 'organization', ...staff },
      ),
      role(
        roles.member,
        [allow([permissions.customers.read, permissions.quotes.read])],
        { on: 'organization', ...staff },
      ),
      role(roles.viewer, [allow(permissions.customers.read)], {
        on: 'organization',
        ...staff,
      }),
      role(roles.contact, [allow(permissions.quotes.read)], {
        on: 'customer',
        for: ['contact'],
      }),
      role(roles['platform-admin'], [
        allow([
          permissions.organizations.read,
          permissions.organizations.update,
        ]),
      ]),
    ],
  },
);
