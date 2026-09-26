import { command, getRequestEvent } from '$app/server';
import { deleteProject } from '@permdock/e2e-saas-kit';

/** A remote command: the server re-checks with a fresh instance. */
export const removeProject = command('unchecked', async (id: unknown) => {
  const { locals } = getRequestEvent();
  return deleteProject(locals.session, typeof id === 'string' ? id : '');
});
