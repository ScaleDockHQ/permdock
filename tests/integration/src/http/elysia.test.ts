import type { ElysiaContext } from 'permdock/elysia';

import { Elysia } from 'elysia';
import { createPermDock } from 'permdock/elysia';
import { testHttpAdapter } from 'permdock/testing';
import { saasPermissions as p } from 'permdock/testing/saas';

const scoped = (ctx: unknown) => ctx as ElysiaContext;

testHttpAdapter({
  name: 'permdock/elysia on app.handle',
  mount(domain) {
    const { permdock, protect, permdockHandler } = createPermDock(
      domain.policy,
      {
        subject: (ctx) =>
          domain.subject(
            ctx.request.headers.get('authorization') ?? undefined,
            new URL(ctx.request.url).pathname,
          ),
        tenant: (ctx) => ctx.params?.['org'],
        customRoles: domain.customRoles,
        store: domain.store,
        limits: domain.limits,
      },
    );
    const row = (ctx: {
      readonly params?: Readonly<Record<string, string | undefined>>;
    }) => domain.project(ctx.params?.['id']);

    const admin = new Elysia({ prefix: '/:org/admin' })
      .use(permdock())
      .get('/members', () => ({ members: [] }), {
        beforeHandle: protect(p.member.list),
      });

    const app = new Elysia()
      .use(permdock())
      .use(
        new Elysia({ prefix: '/:org/permdock/access/v1/evaluations' }).use(
          permdockHandler(),
        ),
      )
      .use(admin)
      .get('/:org/projects/:id', (ctx) => scoped(ctx).permdockData, {
        beforeHandle: protect(p.project.read, row),
      })
      .patch('/:org/projects/:id', ({ params }) => ({ id: params.id }), {
        beforeHandle: protect(p.project.update, row),
      })
      .post(
        '/:org/projects',
        (ctx) => {
          ctx.set.status = 201;
          return scoped(ctx).permdockData;
        },
        {
          beforeHandle: protect(p.project.create, (ctx) => ctx.body, {
            trusted: false,
          }),
        },
      )
      .delete(
        '/:org/projects/:id',
        (ctx) => {
          const { permdock: instance, permdockData } = scoped(ctx);
          instance.assert(p.project.delete, permdockData);
          return new Response(null, { status: 204 });
        },
        { beforeHandle: protect(p.project.read, row) },
      )
      .post(
        '/:org/projects/:id/files',
        (ctx) => {
          const file = (ctx.body as { readonly file?: unknown } | undefined)
            ?.file;
          if (!(file instanceof File)) {
            ctx.set.status = 400;
            return { error: 'file required' };
          }
          ctx.set.status = 201;
          return { name: file.name, size: file.size };
        },
        { beforeHandle: protect(p.project.update, row) },
      )
      .get('/:org/analytics', () => ({ ok: true }), {
        beforeHandle: protect(p.analytics.read),
      })
      .post(
        '/:org/api-keys',
        (ctx) => {
          ctx.set.status = 201;
          return { ok: true };
        },
        { beforeHandle: protect(p.apiKey.create) },
      )
      .post(
        '/:org/api-keys/revoke-all',
        () => new Response(null, { status: 204 }),
        { beforeHandle: protect(p.apiKey.revokeAll) },
      );

    return { fetch: (request) => app.handle(request) };
  },
});
