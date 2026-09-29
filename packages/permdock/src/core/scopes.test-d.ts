import { describe, it } from 'vitest';

import type { Principal } from './subject.ts';

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../index.ts';

const tree = definePermissions({
  quote: resource({
    actions: ['read'],
    relations: {
      organization: { field: 'organization_id', memberOf: 'organization' },
      customer: { field: 'customer_id', memberOf: 'customer' },
    },
  }),
});

const subject = (user: Principal | null) => user;
const scopes = {
  organization: { key: 'organization_id' },
  customer: { key: 'customer_id', within: 'organization' },
} as const;

describe('role on: is typed against the declared scopes', () => {
  it('accepts declared names and the aliases', () => {
    definePolicy(tree, {
      subject,
      scopes,
      roles: [
        role('staff', [allow(tree.quote.read)], { on: 'organization' }),
        role('contact', [allow(tree.quote.read)], { on: 'customer' }),
        role('alias', [allow(tree.quote.read)], { on: 'tenant' }),
        role('global', [allow(tree.quote.read)]),
        role('owner', [allow(tree.quote.read)], { on: tree.quote }),
      ],
    });
  });

  it('rejects an undeclared scope name', () => {
    definePolicy(tree, {
      subject,
      scopes,
      roles: [
        // @ts-expect-error 'customers' is not a declared scope
        role('typo', [allow(tree.quote.read)], { on: 'customers' }),
      ],
    });
  });
});
