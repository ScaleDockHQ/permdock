import { allow, role } from 'permdock';

import { billingPermissions } from './permissions.ts';

export const billingRoles = [
  role('member', [
    allow(billingPermissions.billing.invoice.read),
    allow(billingPermissions.billing.plan.view),
  ]),
  role('admin', [
    allow(billingPermissions.billing.invoice.pay),
    allow(billingPermissions.billing.plan.change),
  ]),
];
