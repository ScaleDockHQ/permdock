import { allow, authenticated, definePolicy, principal } from 'permdock';

import { permissions } from './permissions.ts';

const attrs = principal['claims']['attrs'];
const inRegions = { region: { in: attrs['regions'] } };
const notBlocked = { region: { notIn: attrs['blocked'] } };

export const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.report.read, {
      to: authenticated(),
      where: {
        region: attrs['region'],
        clearance: { lte: attrs['clearance'] },
      },
    }),
    allow([permissions.ticket.read, permissions.ticket.update], {
      to: authenticated(),
      where: inRegions,
    }),
    allow([permissions.record.read, permissions.record.delete], {
      to: authenticated(),
      where: notBlocked,
    }),
  ],
  principal: (user: { readonly id: string } | null) => user,
});
