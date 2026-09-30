import type { z } from 'zod';

import {
  allow,
  anyone,
  definePolicy,
  deny,
  type GrantOptions,
  principal,
  role,
} from 'permdock';

import { type Invoice, permissions } from './permissions.ts';

const { invoice } = permissions;

// A `where` shorthand next to `fields` would infer the row type from the shorthand alone.
const publicRead: GrantOptions<z.infer<typeof Invoice>> = {
  to: anyone(),
  where: { orgId: 'public' },
  fields: ['id', 'title'],
};

export const policy = definePolicy(permissions, {
  roles: [
    role('admin', [allow([invoice.read, invoice.update])], { on: 'tenant' }),
    role(
      'finance',
      [allow(invoice.read, { fields: ['id', 'orgId', 'title', 'amount'] })],
      { on: 'tenant' },
    ),
    role(
      'member',
      [
        allow(invoice.read, { fields: ['id', 'orgId', 'authorId', 'title'] }),
        allow(invoice.read, { where: { authorId: principal.id } }),
      ],
      { on: 'tenant' },
    ),
    role('auditor', [
      allow(invoice.read),
      deny(invoice.read, { fields: ['note'] }),
    ]),
  ],
  grants: [allow(invoice.read, publicRead)],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
