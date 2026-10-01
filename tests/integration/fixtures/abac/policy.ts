import { allow, authenticated, definePolicy, principal } from 'permdock';

import { permissions } from './permissions.ts';

type Ref = typeof principal;
type AttrRefs = Ref &
  Readonly<Record<'regions' | 'blocked' | 'region' | 'clearance', Ref>>;

// SAFETY: the `principal` proxy returns a `SubjectRef` for every string key.
const attrs = principal['claims']?.['attrs'] as AttrRefs;
const inRegions = { region: { in: attrs.regions } };
const notBlocked = { region: { notIn: attrs.blocked } };

export const policy = definePolicy(permissions, {
  grants: [
    allow(permissions.report.read, {
      to: authenticated(),
      where: {
        region: attrs.region,
        clearance: { lte: attrs.clearance },
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
    allow(permissions.note.read, {
      to: authenticated(),
      where: { title: { contains: '50%_off' } },
    }),
  ],
  principal: (user: { readonly id: string } | null) => user,
});
