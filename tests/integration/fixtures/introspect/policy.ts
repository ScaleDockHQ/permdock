import {
  actor,
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from 'permdock';
import { z } from 'zod';

const Doc = z.object({
  id: z.string(),
  orgId: z.string(),
  tags: z.array(z.string()),
});

export const permissions = definePermissions({
  doc: resource(Doc, {
    id: 'id',
    actions: ['read', 'delete'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
  }),
});

export const policy = definePolicy(permissions, {
  roles: [
    role(
      'member',
      [
        allow(permissions.doc.read, {
          where: { tags: { contains: 'public' } },
        }),
        allow(permissions.doc.delete),
      ],
      { on: 'tenant' },
    ),
  ],
  grants: [deny(permissions.doc.delete, { to: actor('oauth-client') })],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
