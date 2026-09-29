import { requireAccess } from '../../../permdock/server.ts';
import { permissions } from '../../../permissions.ts';

// A rarely visited admin page: never prefetched, and allowed to block, because
// it checks access at request time before rendering anything.
export const prefetch = 'force-disabled';
export const instant = false;

export default async function Settings(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  await requireAccess({ permission: permissions.member.manage, tenant: org });
  return (
    <section data-testid="settings">
      <h1>Settings</h1>
      <p>Only organization admins reach this page.</p>
    </section>
  );
}
