import type { FastifyRequest } from 'fastify';

import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { createPermDock, type PermDockRequest } from 'permdock/fastify';
import { testHttpAdapter } from 'permdock/testing';
import { saasPermissions as p } from 'permdock/testing/saas';

import { forward } from '../support/listen.ts';

type Params = { readonly org?: string; readonly id?: string };

testHttpAdapter({
  name: 'permdock/fastify',
  async mount(domain) {
    const { permdock, protect, permdockHandler } = createPermDock(
      domain.policy,
      {
        subject: (request) =>
          domain.subject(request.headers.authorization, request.url),
        tenant: (request) => (request.params as Params).org,
        customRoles: domain.customRoles,
        store: domain.store,
        limits: domain.limits,
      },
    );
    const row = (request: FastifyRequest) =>
      domain.project((request.params as Params).id);

    const app = Fastify();
    await app.register(multipart);
    await app.register(permdock);
    await app.register(permdockHandler, {
      prefix: '/:org/permdock/access/v1/evaluations',
    });
    await app.register(
      (admin) => {
        admin.get('/members', { preHandler: protect(p.member.list) }, () => ({
          members: [],
        }));
        return Promise.resolve();
      },
      { prefix: '/:org/admin' },
    );
    app.get(
      '/:org/projects/:id',
      { preHandler: protect(p.project.read, row) },
      (request) => (request as PermDockRequest).permdockData,
    );
    app.patch(
      '/:org/projects/:id',
      { preHandler: protect(p.project.update, row) },
      (request) => ({ id: (request.params as Params).id }),
    );
    app.post(
      '/:org/projects',
      {
        preHandler: protect(p.project.create, (request) => request.body, {
          trusted: false,
        }),
      },
      async (request, reply) =>
        reply.code(201).send((request as PermDockRequest).permdockData),
    );
    app.delete(
      '/:org/projects/:id',
      { preHandler: protect(p.project.read, row) },
      async (request, reply) => {
        const scoped = request as PermDockRequest;
        scoped.permdock.assert(p.project.delete, scoped.permdockData);
        return reply.code(204).send();
      },
    );
    app.post(
      '/:org/projects/:id/files',
      { preHandler: protect(p.project.update, row) },
      async (request, reply) => {
        const file = await request.file();
        if (file === undefined) {
          return reply.code(400).send();
        }
        const bytes = await file.toBuffer();
        return reply
          .code(201)
          .send({ name: file.filename, size: bytes.byteLength });
      },
    );
    app.get(
      '/:org/analytics',
      { preHandler: protect(p.analytics.read) },
      () => ({ ok: true }),
    );
    app.post(
      '/:org/api-keys',
      { preHandler: protect(p.apiKey.create) },
      async (_request, reply) => reply.code(201).send({ ok: true }),
    );
    app.post(
      '/:org/api-keys/revoke-all',
      { preHandler: protect(p.apiKey.revokeAll) },
      async (_request, reply) => reply.code(204).send(),
    );

    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    return {
      fetch: (request) => forward(origin, request),
      close: () => app.close(),
    };
  },
});
