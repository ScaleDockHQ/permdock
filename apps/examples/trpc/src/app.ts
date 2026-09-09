import { initTRPC } from '@trpc/server';
import { createPermDock } from 'permdock/trpc';
import { z } from 'zod';

import { ownPost, permissions } from './permissions.ts';
import { policy, type User } from './policy.ts';

type Ctx = { readonly user: User };

const t = initTRPC.context<Ctx>().create();
const { permdock, protect } = createPermDock<Ctx>(policy, {
  subject: (opts) => opts.ctx.user,
});

const procedure = t.procedure.use(permdock());

export const appRouter = t.router({
  health: t.procedure.query(() => ({ ok: true as const })),
  posts: t.router({
    update: procedure
      .input(z.object({ id: z.string() }))
      .use(protect(permissions.post.update, () => ownPost))
      .mutation(() => ({ ok: true as const })),
    publish: procedure
      .input(z.object({ id: z.string() }))
      .use(protect(permissions.post.publish, () => ownPost))
      .mutation(() => ({ ok: true as const })),
  }),
});

export type AppRouter = typeof appRouter;
