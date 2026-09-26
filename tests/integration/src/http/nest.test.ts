import 'reflect-metadata';
import type { INestApplication, Type } from '@nestjs/common';
import type { HttpMounted, HttpScenarioDomain } from '@permdock/testing';
import type { FastifyRequest } from 'fastify';
import type { NestRequest } from 'permdock/nest';

import multipart from '@fastify/multipart';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { APP_GUARD, NestFactory, RouterModule } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { testHttpAdapter } from '@permdock/testing';
import { saasPermissions as p } from '@permdock/testing/saas';
import { createPermDock } from 'permdock/nest';

import { forward } from '../support/listen.ts';

type Platform = 'express' | 'fastify';

function method(
  cls: Type<unknown>,
  key: string,
  ...decorators: readonly MethodDecorator[]
): void {
  const proto = cls.prototype as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, key);
  if (descriptor === undefined) {
    throw new TypeError(`missing ${key}`);
  }
  for (const decorator of decorators) {
    decorator(proto, key, descriptor);
  }
}

function parameter(
  cls: Type<unknown>,
  key: string,
  index: number,
  decorator: ParameterDecorator,
): void {
  decorator(cls.prototype as object, key, index);
}

function appModule(
  domain: HttpScenarioDomain,
  platform: Platform,
): Type<unknown> {
  const { PermDockModule, PermDockGuard, Protect, permdockHandler } =
    createPermDock(domain.policy, {
      subject: (req) =>
        domain.subject(
          req.headers.authorization,
          req.originalUrl ?? req.url ?? '/',
        ),
      tenant: (req) => req.params?.org,
      customRoles: domain.customRoles,
      store: domain.store,
      limits: domain.limits,
    });
  const row = (req: NestRequest) => domain.project(req.params?.id);

  class AdminController {
    members() {
      return { members: [] };
    }
  }
  Controller()(AdminController);
  method(AdminController, 'members', Get('members'), Protect(p.member.list));

  class AdminModule {}
  Module({ controllers: [AdminController] })(AdminModule);

  class ProjectsController {
    read(req: NestRequest) {
      return req.permdockData;
    }

    update(req: NestRequest) {
      return { id: req.params?.id };
    }

    create(req: NestRequest) {
      return req.permdockData;
    }

    remove(req: NestRequest) {
      req.permdock?.assert(p.project.delete, req.permdockData);
    }

    async upload(req: NestRequest, file?: Express.Multer.File) {
      if (platform === 'express') {
        return file === undefined
          ? undefined
          : { name: file.originalname, size: file.size };
      }
      const part = await (req as unknown as FastifyRequest).file();
      if (part === undefined) {
        return null;
      }
      const bytes = await part.toBuffer();
      return { name: part.filename, size: bytes.byteLength };
    }

    analytics() {
      return { ok: true };
    }

    createKey() {
      return { ok: true };
    }

    revokeAll() {
      return null;
    }
  }
  Controller(':org')(ProjectsController);
  method(
    ProjectsController,
    'read',
    Get('projects/:id'),
    Protect(p.project.read, row),
  );
  method(
    ProjectsController,
    'update',
    Patch('projects/:id'),
    Protect(p.project.update, row),
  );
  method(
    ProjectsController,
    'create',
    Post('projects'),
    Protect(p.project.create, (req) => req.body, { trusted: false }),
  );
  method(
    ProjectsController,
    'remove',
    Delete('projects/:id'),
    HttpCode(204),
    Protect(p.project.read, row),
  );
  method(
    ProjectsController,
    'upload',
    Post('projects/:id/files'),
    Protect(p.project.update, row),
    ...(platform === 'express'
      ? [UseInterceptors(FileInterceptor('file'))]
      : []),
  );
  method(
    ProjectsController,
    'analytics',
    Get('analytics'),
    Protect(p.analytics.read),
  );
  method(
    ProjectsController,
    'createKey',
    Post('api-keys'),
    Protect(p.apiKey.create),
  );
  method(
    ProjectsController,
    'revokeAll',
    Post('api-keys/revoke-all'),
    HttpCode(204),
    Protect(p.apiKey.revokeAll),
  );
  for (const key of ['read', 'update', 'create', 'remove', 'upload']) {
    parameter(ProjectsController, key, 0, Req());
  }
  if (platform === 'express') {
    parameter(ProjectsController, 'upload', 1, UploadedFile());
  }

  class AppModule {}
  Module({
    imports: [
      PermDockModule,
      AdminModule,
      RouterModule.register([{ path: ':org/admin', module: AdminModule }]),
    ],
    controllers: [
      ProjectsController,
      permdockHandler({ path: ':org/permdock/access/v1/evaluations' }),
    ],
    providers: [{ provide: APP_GUARD, useExisting: PermDockGuard }],
  })(AppModule);
  return AppModule;
}

async function serve(app: INestApplication): Promise<HttpMounted> {
  await app.listen(0, '127.0.0.1');
  const origin = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return {
    fetch: (request) => forward(origin, request),
    close: () => app.close(),
  };
}

testHttpAdapter({
  name: 'permdock/nest on platform-express',
  async mount(domain) {
    return serve(
      await NestFactory.create(appModule(domain, 'express'), { logger: false }),
    );
  },
});

testHttpAdapter({
  name: 'permdock/nest on platform-fastify',
  async mount(domain) {
    const app = await NestFactory.create<NestFastifyApplication>(
      appModule(domain, 'fastify'),
      new FastifyAdapter(),
      { logger: false },
    );
    // Nest pins its own `fastify` types; the plugin is the same at runtime.
    await app.register(
      multipart as unknown as Parameters<typeof app.register>[0],
    );
    return serve(app);
  },
});
