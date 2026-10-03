import type { PermDock, Permission } from '../../src/index.ts';
import type { ServerPermDock } from '../../src/server/index.ts';
import type {
  HttpCall,
  HttpMounted,
  HttpResult,
  HttpScenarioDomain,
} from '../../src/testing/http-adapter.ts';

import { APPROVAL_HEADER } from '../../src/approvals/index.ts';
import {
  createPermDock,
  PermDockRevokedError,
  problemFromError,
} from '../../src/server/index.ts';
import { testHttpAdapter } from '../../src/testing/http-adapter.ts';
import { saasPermissions as p } from '../../src/testing/saas/index.ts';

type Handler = (context: {
  readonly request: Request;
  readonly id: string | undefined;
  readonly data: unknown;
  readonly permdock: PermDock;
}) => Promise<Response> | Response;

type Route = readonly [
  method: string,
  pathname: string,
  permission: Permission,
  load: 'row' | 'body' | 'none',
  handle: Handler,
];

const routes: readonly Route[] = [
  [
    'GET',
    '/:org/admin/members',
    p.member.list,
    'none',
    () => Response.json({ members: [] }),
  ],
  [
    'GET',
    '/:org/projects/:id',
    p.project.read,
    'row',
    ({ data }) => Response.json(data),
  ],
  [
    'PATCH',
    '/:org/projects/:id',
    p.project.update,
    'row',
    ({ id }) => Response.json({ id }),
  ],
  [
    'POST',
    '/:org/projects',
    p.project.create,
    'body',
    ({ data }) => Response.json(data, { status: 201 }),
  ],
  [
    'DELETE',
    '/:org/projects/:id',
    p.project.read,
    'row',
    ({ permdock, data }) => {
      permdock.assert(p.project.delete, data);
      return new Response(null, { status: 204 });
    },
  ],
  [
    'POST',
    '/:org/projects/:id/files',
    p.project.update,
    'row',
    async ({ request }) => {
      const file = (await request.formData()).get('file');
      return file instanceof File
        ? Response.json({ name: file.name, size: file.size }, { status: 201 })
        : new Response(null, { status: 400 });
    },
  ],
  [
    'GET',
    '/:org/analytics',
    p.analytics.read,
    'none',
    () => Response.json({ ok: true }),
  ],
  [
    'POST',
    '/:org/api-keys',
    p.apiKey.create,
    'none',
    () => Response.json({ ok: true }, { status: 201 }),
  ],
  [
    'POST',
    '/:org/api-keys/revoke-all',
    p.apiKey.revokeAll,
    'none',
    () => new Response(null, { status: 204 }),
  ],
];

async function events(
  kernel: ServerPermDock,
  domain: HttpScenarioDomain,
  request: Request,
  id: string | undefined,
): Promise<Response> {
  const row = domain.project(id);
  const guard = await kernel.protect(p.project.read, () => row)(request);
  if (!guard.ok) {
    return guard.response;
  }
  const conn = await kernel.connection(request, {
    permission: p.project.read,
    data: row,
  });
  const org = domain.org(new URL(request.url).pathname);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const frame = (text: string): void => {
        controller.enqueue(encoder.encode(`${text}\n\n`));
      };
      try {
        for await (const item of domain.ticks(org, conn.signal)) {
          for (const readable of conn.filter(p.project.update, [item])) {
            frame(`data: ${JSON.stringify(readable)}`);
          }
        }
        const reason: unknown = conn.signal.reason;
        if (reason instanceof PermDockRevokedError) {
          frame(
            `event: permdock\ndata: ${JSON.stringify(reason.toProblemDetails())}`,
          );
        }
        controller.close();
      } catch {
        // The client went away; enqueue on a cancelled stream throws.
      } finally {
        conn.close();
      }
    },
    cancel() {
      conn.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function mountKernel(
  domain: HttpScenarioDomain,
  resolve: 'session' | 'subject',
): HttpMounted {
  const kernel = createPermDock(domain.policy, {
    revocations: domain.revocations,
    subject: (request) =>
      domain[resolve](
        request.headers.get('authorization'),
        new URL(request.url).pathname,
      ),
    tenant: (request) => domain.org(new URL(request.url).pathname),
    customRoles: domain.customRoles,
    store: domain.store,
    limits: domain.limits,
  });
  const evaluations = kernel.permdockHandler();
  const eventsPath = new URLPattern({
    pathname: '/:org/projects/:id/events',
  });
  const evaluationsPath = new URLPattern({
    pathname: '/:org/permdock/access/v1/evaluations',
  });
  const table = routes.map(
    ([method, pathname, permission, load, handle]) =>
      [method, new URLPattern({ pathname }), permission, load, handle] as const,
  );

  const app = async (request: Request): Promise<Response> => {
    const stream =
      request.method === 'GET' ? eventsPath.exec(request.url) : null;
    if (stream !== null) {
      return events(kernel, domain, request, stream.pathname.groups['id']);
    }
    if (evaluationsPath.test(request.url)) {
      return request.method === 'GET'
        ? evaluations.GET(request)
        : evaluations.POST(request);
    }
    for (const [method, pattern, permission, load, handle] of table) {
      const match =
        method === request.method ? pattern.exec(request.url) : null;
      if (match === null) {
        continue;
      }
      const id = match.pathname.groups['id'];
      // SAFETY: widens the any from json() to unknown; trusted: false makes the kernel validate it.
      const guard = await kernel.protect(
        permission,
        load === 'row'
          ? () => domain.project(id)
          : load === 'body'
            ? (incoming) => incoming.clone().json() as Promise<unknown>
            : undefined,
        load === 'body' ? { trusted: false } : undefined,
      )(request);
      if (!guard.ok) {
        return guard.response;
      }
      try {
        return await handle({
          request,
          id,
          data: guard.data,
          permdock: guard.permdock,
        });
      } catch (error) {
        const problem = problemFromError(error);
        if (problem === undefined) {
          throw error;
        }
        return problem;
      }
    }
    return new Response(null, { status: 404 });
  };

  return { fetch: app, close: async () => undefined };
}

testHttpAdapter({
  name: 'permdock/server kernel, in process',
  streams: true,
  mount: (domain) => mountKernel(domain, 'session'),
});

testHttpAdapter({
  name: 'permdock/server kernel, subject without a session',
  skip: { upload: 'covered by the session mount' },
  mount: (domain) => mountKernel(domain, 'subject'),
});

/** An anonymous call carries a non-Bearer header, which must stay anonymous. */
function rpcRequest(call: HttpCall): Request {
  const headers = new Headers({
    'content-type': 'application/json',
    authorization: call.authorization ?? 'Basic Og==',
  });
  if (call.approval !== undefined) {
    headers.set(APPROVAL_HEADER, call.approval);
  }
  const at = (method: string, path: string, body?: unknown): Request =>
    new Request(`http://rpc.test/${call.org}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  switch (call.op) {
    case 'project.get':
      return at('GET', `/projects/${call.id}`);
    case 'project.update':
      return at('PATCH', `/projects/${call.id}`, { name: 'Renamed' });
    case 'project.create':
      return at('POST', '/projects', call.body);
    case 'project.delete':
      return at('DELETE', `/projects/${call.id}`);
    case 'project.upload':
      throw new Error('multipart does not travel over this transport');
    case 'analytics.read':
      return at('GET', '/analytics');
    case 'apiKey.create':
      return at('POST', '/api-keys');
    case 'apiKey.revokeAll':
      return at('POST', '/api-keys/revoke-all');
    case 'admin.members':
      return at('GET', '/admin/members');
    case 'evaluations':
      return at('POST', '/permdock/access/v1/evaluations', call.body);
    default: {
      const exhaustive: never = call;
      return exhaustive;
    }
  }
}

testHttpAdapter({
  name: 'permdock/server kernel, over a call transport',
  skip: { upload: 'multipart does not travel over this transport' },
  mount(domain) {
    const app = mountKernel(domain, 'session').fetch;
    return {
      async call(call): Promise<HttpResult> {
        const response = await app?.(rpcRequest(call));
        if (response === undefined) {
          throw new Error('the kernel mount serves fetch');
        }
        const text = await response.text();
        const body: unknown = text.length === 0 ? null : JSON.parse(text);
        return { status: response.status, body };
      },
    };
  },
});
