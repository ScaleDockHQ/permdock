import type { Server } from 'node:http';
import type { PermDock, Permission } from 'permdock';

import { createAdaptorServer } from '@hono/node-server';
import { testHttpAdapter } from '@permdock/testing';
import {
  saasJwks,
  saasPermissions as p,
  saasPrincipal,
} from '@permdock/testing/saas';
import { pipeline } from '@supabase/middleware';
import { withClaims } from '@supabase/server/middleware/claims';
import { problemFromError } from 'permdock/server';
import { createPermDock } from 'permdock/supabase/middleware';

import { listen } from '../support/listen.ts';

const pathOf = (request: Request) => new URL(request.url).pathname;

type Load = 'row' | 'body' | 'none';

testHttpAdapter({
  name: 'permdock/supabase/middleware in a @supabase/middleware pipeline',
  async mount(domain) {
    const idOf = (request: Request) => pathOf(request).split('/')[3];
    // `ctx.jwtClaims` is the JWKS-verified payload from `withClaims`.
    const { withPermDock, permdockHandler } = createPermDock(domain.policy, {
      subject: (ctx, request) =>
        ctx.jwtClaims === null
          ? null
          : saasPrincipal(ctx.jwtClaims.sub, domain.org(pathOf(request))),
      tenant: (_ctx, request) => domain.org(pathOf(request)),
      customRoles: domain.customRoles,
      store: domain.store,
      limits: domain.limits,
    });
    const claims = withClaims({ jwks: saasJwks });

    const guarded = (
      permission: Permission,
      load: Load,
      handle: (
        request: Request,
        ctx: { readonly permdock: PermDock },
      ) => Promise<Response> | Response,
    ) =>
      pipeline(
        [
          claims,
          withPermDock({
            protect: permission,
            ...(load === 'row'
              ? { data: (_ctx, request) => domain.project(idOf(request)) }
              : load === 'body'
                ? {
                    data: (_ctx, request) => request.clone().json(),
                    trusted: false,
                  }
                : {}),
          }),
        ],
        async (request, ctx) => handle(request, ctx),
      );

    const routes: readonly (readonly [
      string,
      RegExp,
      (request: Request) => Promise<Response>,
    ])[] = [
      [
        'GET',
        /^\/[^/]+\/admin\/members$/u,
        guarded(p.member.list, 'none', () => Response.json({ members: [] })),
      ],
      [
        'GET',
        /^\/[^/]+\/projects\/[^/]+$/u,
        guarded(p.project.read, 'row', (request) =>
          Response.json(domain.project(idOf(request))),
        ),
      ],
      [
        'PATCH',
        /^\/[^/]+\/projects\/[^/]+$/u,
        guarded(p.project.update, 'row', (request) =>
          Response.json({ id: idOf(request) }),
        ),
      ],
      [
        'POST',
        /^\/[^/]+\/projects$/u,
        guarded(p.project.create, 'body', async (request) =>
          Response.json(await request.json(), { status: 201 }),
        ),
      ],
      [
        'DELETE',
        /^\/[^/]+\/projects\/[^/]+$/u,
        guarded(p.project.read, 'row', (request, ctx) => {
          ctx.permdock.assert(p.project.delete, domain.project(idOf(request)));
          return new Response(null, { status: 204 });
        }),
      ],
      [
        'POST',
        /^\/[^/]+\/projects\/[^/]+\/files$/u,
        guarded(p.project.update, 'row', async (request) => {
          // oxlint-disable-next-line typescript/no-deprecated -- the upload is a trusted test client, not a remote server
          const file = (await request.formData()).get('file');
          return file instanceof File
            ? Response.json(
                { name: file.name, size: file.size },
                { status: 201 },
              )
            : new Response(null, { status: 400 });
        }),
      ],
      [
        'GET',
        /^\/[^/]+\/analytics$/u,
        guarded(p.analytics.read, 'none', () => Response.json({ ok: true })),
      ],
      [
        'POST',
        /^\/[^/]+\/api-keys$/u,
        guarded(p.apiKey.create, 'none', () =>
          Response.json({ ok: true }, { status: 201 }),
        ),
      ],
      [
        'POST',
        /^\/[^/]+\/api-keys\/revoke-all$/u,
        guarded(
          p.apiKey.revokeAll,
          'none',
          () => new Response(null, { status: 204 }),
        ),
      ],
      [
        'POST',
        /^\/[^/]+\/permdock\/access\/v1\/evaluations$/u,
        pipeline([claims], permdockHandler()),
      ],
    ];

    const app = async (request: Request): Promise<Response> => {
      const path = pathOf(request);
      const route = routes.find(
        ([method, pattern]) => method === request.method && pattern.test(path),
      );
      if (route === undefined) {
        return new Response(null, { status: 404 });
      }
      // Pipeline entries cannot wrap the handler, so the app maps a thrown `assert`.
      try {
        return await route[2](request);
      } catch (error) {
        const problem = problemFromError(error);
        if (problem === undefined) {
          throw error;
        }
        return problem;
      }
    };

    return listen(createAdaptorServer({ fetch: app }) as Server);
  },
});
