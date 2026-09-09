import { mergePermissions } from 'permdock';

import { billingPermissions } from '../packages/billing/src/permissions.ts';
import { postPermissions } from '../packages/posts/src/permissions.ts';

export const permissions = mergePermissions(
  postPermissions,
  billingPermissions,
);
