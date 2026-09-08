import 'reflect-metadata';
import type { Policy } from 'permdock';

import { Controller, Get, Module, Patch, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createPermDock } from 'permdock/nest';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const { PermDockModule, PermDockGuard, Protect, permdockHandler } =
  createPermDock(policy as Policy, {
    subject: () => memberUser,
  });

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { ok: true };
  }
}

@Controller('posts')
class PostsController {
  @Patch(':id')
  @Protect(permissions.post.update, () => ownPost)
  update() {
    return { ok: true };
  }

  @Post(':id/publish')
  @Protect(permissions.post.publish, () => ownPost)
  publish() {
    return { ok: true };
  }
}

@Module({
  imports: [PermDockModule],
  controllers: [HealthController, PostsController, permdockHandler()],
  providers: [{ provide: APP_GUARD, useExisting: PermDockGuard }],
})
export class AppModule {}
