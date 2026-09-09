import { definePolicy } from 'permdock';

import { billingRoles } from '../packages/billing/src/policy.ts';
import { postRoles } from '../packages/posts/src/policy.ts';
import { permissions } from './permissions.ts';

export type User = {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
};

export const policy = definePolicy(permissions, {
  roles: [...postRoles, ...billingRoles],
  subject: (user: User | null) =>
    user === null
      ? null
      : { id: user.id, orgId: user.orgId, roles: user.roles },
  validate: 'boundary',
});
