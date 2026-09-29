import { allow, definePolicy, relation } from 'permdock';

import { permissions } from './permissions.ts';

const { doc, employee, folder } = permissions;

const viewer = relation(folder, 'viewer', { through: 'parent', depth: 4 });

export const policy = definePolicy(permissions, {
  grants: [
    allow(doc.read, { to: relation(doc, 'owner') }),
    allow(doc.read, { to: viewer }),
    allow(doc.update, {
      to: relation(folder, 'editor', { through: 'parent', depth: 2 }),
    }),
    allow(folder.read, { to: viewer }),
    allow(folder.read, {
      to: relation(folder, 'owner', { through: 'parent', depth: 4 }),
    }),
    allow(folder.update, { to: relation(folder, 'editor') }),
    allow(employee.read, {
      to: relation(employee, 'manager', { through: 'parent', depth: 3 }),
    }),
  ],
  subject: () => null,
});
