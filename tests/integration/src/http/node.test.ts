import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Permission } from 'permdock';

import { createServer } from 'node:http';
import { createPermDock, toRequest } from 'permdock/node';
import { problemFromError } from 'permdock/server';
import { testHttpAdapter } from 'permdock/testing';
import { saasPermissions as p } from 'permdock/testing/saas';

import { listen } from '../support/listen.ts';

type Route = {
  readonly method: string;
  readonly pattern: URLPattern;
  readonly permission: Permission;
  readonly load?: 'row' | 'body';
  readonly handle: (context: {
    readonly req: IncomingMessage;
    readonly params: Readonly<Record<string, string | undefined>>;
    readonly data: unknown;
    readonly permdock: Awaited<
      ReturnType<ReturnType<typeof createPermDock>['permdock']>
    >;
  }) => Promise<Response> | Response;
};

const route = (
  method: string,
  pathname: string,
  permission: Permission,
  handle: Route['handle'],
  load?: Route['load'],
): Route => ({
  method,
  pattern: new URLPattern({ pathname }),
  permission,
  handle,
  ...(load === undefined ? {} : { load }),
});

testHttpAdapter({
  name: 'permdock/node on node:http',
  async mount(domain) {
    const params = new WeakMap<
      IncomingMessage,
      Record<string, string | undefined>
    >();
    const { protect, send, permdockHandler } = createPermDock(domain.policy, {
      subject: (req) =>
        domain.subject(req.headers.authorization, req.url ?? '/'),
      tenant: (req) => params.get(req)?.['org'],
      customRoles: domain.customRoles,
      store: domain.store,
      limits: domain.limits,
    });
    const evaluations = permdockHandler();
    const evaluationsPath = new URLPattern({
      pathname: '/:org/permdock/access/v1/evaluations',
    });

    const routes: readonly Route[] = [
      route('GET', '/:org/admin/members', p.member.list, () =>
        Response.json({ members: [] }),
      ),
      route(
        'GET',
        '/:org/projects/:id',
        p.project.read,
        ({ data }) => Response.json(data),
        'row',
      ),
      route(
        'PATCH',
        '/:org/projects/:id',
        p.project.update,
        ({ params: { id } }) => Response.json({ id }),
        'row',
      ),
      route(
        'POST',
        '/:org/projects',
        p.project.create,
        ({ data }) => Response.json(data, { status: 201 }),
        'body',
      ),
      route(
        'DELETE',
        '/:org/projects/:id',
        p.project.read,
        ({ permdock, data }) => {
          permdock.assert(p.project.delete, data);
          return new Response(null, { status: 204 });
        },
        'row',
      ),
      route(
        'POST',
        '/:org/projects/:id/files',
        p.project.update,
        async ({ req }) => {
          // oxlint-disable-next-line typescript/no-deprecated -- the upload is a trusted test client, not a remote server
          const file = (await toRequest(req).formData()).get('file');
          if (!(file instanceof File)) {
            return new Response(null, { status: 400 });
          }
          return Response.json(
            { name: file.name, size: file.size },
            { status: 201 },
          );
        },
        'row',
      ),
      route('GET', '/:org/analytics', p.analytics.read, () =>
        Response.json({ ok: true }),
      ),
      route('POST', '/:org/api-keys', p.apiKey.create, () =>
        Response.json({ ok: true }, { status: 201 }),
      ),
      route(
        'POST',
        '/:org/api-keys/revoke-all',
        p.apiKey.revokeAll,
        () => new Response(null, { status: 204 }),
      ),
    ];

    const serve = async (
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const tenantOnly = evaluationsPath.exec(url);
      if (tenantOnly !== null) {
        params.set(req, tenantOnly.pathname.groups);
        await evaluations(req, res);
        return;
      }
      for (const entry of routes) {
        const match =
          entry.method === req.method ? entry.pattern.exec(url) : null;
        if (match === null) {
          continue;
        }
        const groups = match.pathname.groups;
        params.set(req, groups);
        const guard = await protect(
          entry.permission,
          entry.load === 'row'
            ? () => domain.project(groups['id'])
            : entry.load === 'body'
              ? (incoming) => toRequest(incoming).json()
              : undefined,
          entry.load === 'body' ? { trusted: false } : undefined,
        )(req);
        if (!guard.ok) {
          await send(res, guard.response);
          return;
        }
        try {
          await send(
            res,
            await entry.handle({
              req,
              params: groups,
              data: guard.data,
              permdock: guard.permdock,
            }),
          );
        } catch (error) {
          const problem = problemFromError(error);
          if (problem === undefined) {
            throw error;
          }
          await send(res, problem);
        }
        return;
      }
      res.statusCode = 404;
      res.end();
    };

    return listen(
      createServer((req, res) => {
        serve(req, res).catch(() => {
          res.statusCode = 500;
          res.end();
        });
      }),
    );
  },
});
