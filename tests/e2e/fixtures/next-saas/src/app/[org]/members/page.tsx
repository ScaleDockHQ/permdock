import { Protected } from 'permdock/react';
import { Suspense } from 'react';

import { getMembers } from '../../../lib/access.ts';
import { permissions } from '../../../permissions.ts';
import { ForbiddenState } from '../forbidden-state.tsx';
import { RoleForm } from './role-form.tsx';

async function MemberList(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  const members = await getMembers(org);
  return (
    <ul aria-label="Members">
      {members.map((member) => (
        <li key={member.user} data-member={member.user}>
          {member.user}{' '}
          <RoleForm org={org} user={member.user} role={member.role} />
        </li>
      ))}
    </ul>
  );
}

export default function MembersPage(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  return (
    <>
      <h1>Members</h1>
      <Suspense
        fallback={<p data-testid="members-loading">Loading members…</p>}
      >
        <Protected
          permission={permissions.member.list}
          fallback={<ForbiddenState label="Members" />}
        >
          <MemberList params={props.params} />
        </Protected>
      </Suspense>
    </>
  );
}
