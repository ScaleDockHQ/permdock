import { saasPermissions as p, saasPolicy } from '@permdock/testing/saas';
import { Elysia } from 'elysia';
import { createPermDock } from 'permdock/elysia';

import { customRoles, projectOf, subjectOf } from './app.ts';

const { permdock, protect } = createPermDock(saasPolicy, {
  subject: (ctx) =>
    subjectOf(ctx.request.headers.get('authorization'), ctx.params?.org),
  tenant: (ctx) => ctx.params?.org,
  customRoles,
});

const row = (ctx: {
  readonly params?: Readonly<Record<string, string | undefined>>;
}) => projectOf(ctx.params?.id);

export const elysia = new Elysia({ prefix: '/elysia' })
  .use(permdock())
  .get('/:org/projects/:id', ({ params }) => projectOf(params.id), {
    beforeHandle: protect(p.project.read, row),
  })
  .patch('/:org/projects/:id', ({ params }) => ({ id: params.id }), {
    beforeHandle: protect(p.project.update, row),
  });
