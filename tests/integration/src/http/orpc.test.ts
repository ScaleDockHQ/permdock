import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpCall, HttpResult } from 'permdock/testing';

import { createAdaptorServer } from '@hono/node-server';
import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { BatchLinkPlugin } from '@orpc/client/plugins';
import { os, type RouterClient } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { BatchHandlerPlugin } from '@orpc/server/plugins';
import { createPermDock } from 'permdock/orpc';
import { testHttpAdapter } from 'permdock/testing';
import { saasPermissions as p } from 'permdock/testing/saas';
import { z } from 'zod';

import { listen } from '../support/listen.ts';

type Context = { readonly req: Request };

const STATUS: Readonly<Record<string, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
};

const Org = z.object({ org: z.string() });
const Row = Org.extend({ id: z.string() });

const ok = (status: number, body: unknown): HttpResult => ({
  status,
  body,
});

testHttpAdapter({
  name: 'permdock/orpc over RPCHandler with BatchLinkPlugin',
  skip: {
    upload: 'the mount takes JSON input; uploads go through a REST route',
  },
  async mount(domain) {
    const { permdock, protect, permdockHandler } = createPermDock<Context>(
      domain.policy,
      {
        subject: (opts) =>
          domain.subject(
            opts.context.req.headers.get('authorization'),
            new URL(opts.context.req.url).pathname,
          ),
        tenant: (opts) =>
          (opts.input as { readonly org?: string } | undefined)?.org ??
          domain.org(new URL(opts.context.req.url).pathname),
        customRoles: domain.customRoles,
        store: domain.store,
        limits: domain.limits,
      },
    );
    const base = os.$context<Context>().use(permdock());
    const row = (opts: { readonly input?: unknown }) =>
      domain.project((opts.input as { readonly id?: string } | undefined)?.id);

    const router = {
      project: {
        get: base
          .input(Row)
          .use(protect(p.project.read, row))
          .handler(({ context }) => context.permdockData),
        update: base
          .input(Row)
          .use(protect(p.project.update, row))
          .handler(({ input }) => ({ id: input.id })),
        create: base
          .input(Org.extend({ body: z.unknown() }))
          .use(
            protect(
              p.project.create,
              (opts) => (opts.input as { readonly body?: unknown }).body,
              {
                trusted: false,
              },
            ),
          )
          .handler(({ context }) => context.permdockData),
        delete: base
          .input(Row)
          .use(protect(p.project.read, row))
          .handler(({ context }) => {
            context.permdock.assert(p.project.delete, context.permdockData);
            return null;
          }),
      },
      analytics: base
        .input(Org)
        .use(protect(p.analytics.read))
        .handler(() => ({ ok: true })),
      apiKey: {
        create: base
          .input(Org)
          .use(protect(p.apiKey.create))
          .handler(() => ({ ok: true })),
        revokeAll: base
          .input(Org)
          .use(protect(p.apiKey.revokeAll))
          .handler(() => null),
      },
      admin: {
        members: base
          .input(Org)
          .use(protect(p.member.list))
          .handler(() => ({ members: [] })),
      },
    };
    const handler = new RPCHandler(router, {
      plugins: [new BatchHandlerPlugin()],
    });

    const server = createAdaptorServer({
      fetch: async (request: Request) => {
        const [org, segment] = new URL(request.url).pathname
          .split('/')
          .slice(1);
        if (segment === 'permdock') {
          return permdockHandler(request);
        }
        const { matched, response } = await handler.handle(request, {
          prefix: `/${org ?? ''}/rpc`,
          context: { req: request },
        });
        return matched ? response : new Response(null, { status: 404 });
      },
    }) as Server;
    const mounted = await listen(server);
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;

    const clients = new Map<string, ReturnType<typeof createClient>>();
    function createClient(call: HttpCall) {
      const headers: Record<string, string> = {};
      if (call.authorization !== null) {
        headers['authorization'] = call.authorization;
      }
      if (call.approval !== undefined) {
        headers['permdock-approval'] = call.approval;
      }
      const link = new RPCLink({
        origin,
        url: `/${call.org}/rpc`,
        headers,
        plugins: [
          new BatchLinkPlugin({
            groups: [{ condition: () => true, context: {} }],
          }),
        ],
      });
      return createORPCClient<RouterClient<typeof router>>(link);
    }
    const clientFor = (call: HttpCall) => {
      const key = JSON.stringify([call.org, call.authorization, call.approval]);
      let client = clients.get(key);
      if (client === undefined) {
        client = createClient(call);
        clients.set(key, client);
      }
      return client;
    };

    const call = async (input: HttpCall): Promise<HttpResult> => {
      const client = clientFor(input);
      const { org } = input;
      try {
        switch (input.op) {
          case 'project.get':
            return ok(200, await client.project.get({ org, id: input.id }));
          case 'project.update':
            return ok(200, await client.project.update({ org, id: input.id }));
          case 'project.create':
            return ok(
              201,
              await client.project.create({ org, body: input.body }),
            );
          case 'project.delete':
            await client.project.delete({ org, id: input.id });
            return ok(204, null);
          case 'project.upload':
            throw new Error('uploads are skipped for oRPC');
          case 'analytics.read':
            return ok(200, await client.analytics({ org }));
          case 'apiKey.create':
            return ok(201, await client.apiKey.create({ org }));
          case 'apiKey.revokeAll':
            await client.apiKey.revokeAll({ org });
            return ok(204, null);
          case 'admin.members':
            return ok(200, await client.admin.members({ org }));
          case 'evaluations': {
            const headers = new Headers({ 'content-type': 'application/json' });
            if (input.authorization !== null) {
              headers.set('authorization', input.authorization);
            }
            const response = await fetch(
              `${origin}/${org}/permdock/access/v1/evaluations`,
              { method: 'POST', headers, body: JSON.stringify(input.body) },
            );
            return ok(response.status, await response.json());
          }
          default: {
            const exhaustive: never = input;
            return exhaustive;
          }
        }
      } catch (error) {
        if (!(error instanceof ORPCError)) {
          throw error;
        }
        return { status: STATUS[error.code] ?? 500, body: error.data };
      }
    };

    return {
      call,
      ...(mounted.close === undefined ? {} : { close: mounted.close }),
    };
  },
});
