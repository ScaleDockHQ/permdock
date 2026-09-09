import 'reflect-metadata';
import { Controller, Get, Module, Patch, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createPermDock } from 'permdock/nest';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const { PermDockModule, PermDockGuard, Protect, permdockHandler } =
  createPermDock(policy, {
    subject: () => memberUser,
  });

function applyMethod(
  cls: new () => unknown,
  key: string,
  decorator: MethodDecorator,
): void {
  const proto: object = cls.prototype as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, key);
  if (!descriptor) {
    throw new TypeError(`missing ${key}`);
  }
  decorator(proto, key, descriptor);
}

class HealthController {
  health() {
    return { ok: true };
  }
}
Controller()(HealthController);
applyMethod(HealthController, 'health', Get('health'));

class PostsController {
  update() {
    return { ok: true };
  }

  publish() {
    return { ok: true };
  }
}
Controller('posts')(PostsController);
applyMethod(PostsController, 'update', Patch(':id'));
applyMethod(
  PostsController,
  'update',
  Protect(permissions.post.update, () => ownPost),
);
applyMethod(PostsController, 'publish', Post(':id/publish'));
applyMethod(
  PostsController,
  'publish',
  Protect(permissions.post.publish, () => ownPost),
);

class AppModule {}
Module({
  imports: [PermDockModule],
  controllers: [HealthController, PostsController, permdockHandler()],
  providers: [{ provide: APP_GUARD, useExisting: PermDockGuard }],
})(AppModule);

export { AppModule };
