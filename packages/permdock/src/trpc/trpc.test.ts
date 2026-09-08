import { initTRPC, TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { createPermDock } from './index.ts';

type Ctx = { readonly user: typeof memberUser | null };

describe('permdock/trpc', () => {
  it('grants and denies through createCaller', async () => {
    const t = initTRPC.context<Ctx>().create();
    const { permdock, protect } = createPermDock(policy, {
      subject: (opts) => opts.ctx.user,
    });
    const procedure = t.procedure.use(permdock());
    const appRouter = t.router({
      update: procedure
        .input(z.object({ id: z.string() }))
        .use(
          protect(permissions.post.update, ({ input }) =>
            input.id === 'p1' ? ownPost : otherPost,
          ),
        )
        .mutation(({ ctx }) => ({
          ok: true as const,
          via: ctx.permdock.subject.principal?.id,
        })),
    });
    const caller = appRouter.createCaller({ user: memberUser });

    await expect(caller.update({ id: 'p1' })).resolves.toEqual({
      ok: true,
      via: 'u1',
    });

    try {
      await caller.update({ id: 'p2' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      const denied = error as TRPCError;
      expect(denied.code).toBe('FORBIDDEN');
      expect(denied.cause).toEqual(
        expect.objectContaining({
          status: 403,
        }),
      );
    }
  });

  it('throws UNAUTHORIZED for an anonymous caller', async () => {
    const t = initTRPC.context<Ctx>().create();
    const { permdock, protect } = createPermDock(policy, {
      subject: (opts) => opts.ctx.user,
    });
    const procedure = t.procedure.use(permdock());
    const appRouter = t.router({
      read: procedure
        .use(protect(permissions.post.read, () => ownPost))
        .query(() => ({ ok: true as const })),
    });
    const caller = appRouter.createCaller({ user: null });

    try {
      await caller.read();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TRPCError);
      expect((error as TRPCError).code).toBe('UNAUTHORIZED');
    }
  });

  it('answers AuthZEN evaluations over Fetch', async () => {
    const { permdockHandler, openapi } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const response = await permdockHandler(
      new Request('http://localhost/permdock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          evaluations: [
            {
              resource: { type: 'post', properties: ownPost },
              action: { name: 'update' },
            },
          ],
        }),
      }),
    );
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);

    const security = openapi.security(permissions.post.delete);
    expect(security.openapi.protect).toBe(true);
    expect(security.openapi['x-permdock-permissions']).toEqual([
      permissions.post.delete.key,
    ]);
  });
});
