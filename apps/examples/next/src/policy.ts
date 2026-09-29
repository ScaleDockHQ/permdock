import type { Membership } from 'permdock';

import { allow, definePolicy, role } from 'permdock';

import { permissions, roles } from './permissions.ts';

export type User = {
  readonly id: string;
  readonly name: string;
  readonly memberships: readonly Membership[];
};

const staffCanRead = [
  allow(permissions.quote.read),
  allow(permissions.quote.list),
  allow(permissions.member.list),
];

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      organization: { key: 'organization_id' },
      customer: { key: 'customer_id', within: 'organization' },
    },
    roles: [
      role(
        roles.admin,
        [
          ...staffCanRead,
          allow(permissions.quote.approve, { where: { status: 'sent' } }),
          allow(permissions.quote.delete),
          allow(permissions.member.manage),
        ],
        { on: 'organization' },
      ),
      role(roles.member, staffCanRead, { on: 'organization' }),
      role(
        roles.contact,
        [
          allow(permissions.quote.read, {
            where: { status: { in: ['sent', 'approved'] } },
          }),
          allow(permissions.quote.list),
          allow(permissions.quote.approve, { where: { status: 'sent' } }),
        ],
        { on: 'customer' },
      ),
    ],
    principal: (user: User | null) =>
      user === null
        ? null
        : { id: user.id, roles: [], memberships: user.memberships },
    validate: 'boundary',
  },
);
