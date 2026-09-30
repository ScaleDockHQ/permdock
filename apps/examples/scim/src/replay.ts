import { GROUP_SCHEMA, ROLES_EXTENSION, USER_SCHEMA } from 'permdock/scim';

import { app, SCIM_TOKEN, TENANT } from './app.ts';
import { permdockFor } from './app.ts';
import { permissions, samplePost } from './permissions.ts';

async function scim(
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${SCIM_TOKEN}`);
  if (typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/scim+json');
  }
  const response = await app.request(
    `https://app.example.com/scim/v2/${TENANT}${path}`,
    { ...init, headers },
  );
  if (response.status === 204) {
    return {};
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function replayProvision(): Promise<{
  readonly afterGroup: boolean;
  readonly afterDeactivate: boolean;
}> {
  const user = await scim('/Users', {
    method: 'POST',
    body: JSON.stringify({
      schemas: [USER_SCHEMA],
      userName: 'ada',
      externalId: 'u_ada',
      active: true,
    }),
  });
  await scim('/Groups', {
    method: 'POST',
    body: JSON.stringify({
      schemas: [GROUP_SCHEMA, ROLES_EXTENSION],
      displayName: 'Editors',
      members: [{ value: user['id'] }],
      [ROLES_EXTENSION]: { roles: ['editor'] },
    }),
  });
  const granted = await permdockFor('u_ada');
  const afterGroup = granted.can(permissions.post.read, samplePost);
  await scim(`/Users/${String(user['id'])}`, {
    method: 'PATCH',
    body: JSON.stringify({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }),
  });
  const denied = await permdockFor('u_ada');
  return {
    afterGroup,
    afterDeactivate: denied.can(permissions.post.read, samplePost),
  };
}
