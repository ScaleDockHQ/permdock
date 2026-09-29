import { Protected } from 'permdock/react';
import { Suspense } from 'react';

import { getStaff } from '../../../lib/access.ts';
import { people } from '../../../lib/store.ts';
import { permissions } from '../../../permissions.ts';
import { changeRole } from '../../actions.ts';

export const instant = true;

function nameOf(user: string): string {
  return people.find((person) => person.id === user)?.name ?? user;
}

async function Staff(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  const staff = await getStaff(org);
  return (
    <ul data-testid="members">
      {staff.map((row) => (
        <li key={row.user}>
          {nameOf(row.user)}: <span data-role={row.user}>{row.role}</span>
          <Protected permission={permissions.member.manage}>
            <form action={changeRole}>
              <input type="hidden" name="organization" value={org} />
              <input type="hidden" name="user" value={row.user} />
              <input
                type="hidden"
                name="role"
                value={row.role === 'admin' ? 'member' : 'admin'}
              />
              <button type="submit" data-change-role={row.user}>
                {row.role === 'admin' ? 'Make member' : 'Make admin'}
              </button>
            </form>
          </Protected>
        </li>
      ))}
    </ul>
  );
}

export default function Members(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  return (
    <section>
      <h1>Members</h1>
      <Protected
        permission={permissions.member.list}
        pending={<p aria-busy="true" />}
        fallback={<p>Only staff can see the member list.</p>}
      >
        <Suspense fallback={<p aria-busy="true" />}>
          <Staff params={props.params} />
        </Suspense>
      </Protected>
    </section>
  );
}
