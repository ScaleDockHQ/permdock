import { Hono } from 'hono';
import { createPermDock } from 'permdock/hono';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

export const otelLog: {
  readonly message: string;
  readonly attributes?: Record<string, unknown> | undefined;
}[] = [];

const { protect } = createPermDock(policy, {
  subject: () => memberUser,
  otel: {
    logger: {
      info(message: string, attributes?: Record<string, unknown>) {
        otelLog.push({ message, attributes });
      },
      warn(message: string, attributes?: Record<string, unknown>) {
        otelLog.push({ message, attributes });
      },
    },
  },
});

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.patch(
  '/posts/:id',
  protect(permissions.post.update, () => ownPost),
  (c) => c.json({ ok: true }),
);

app.post(
  '/posts/:id/publish',
  protect(permissions.post.publish, () => ownPost),
  (c) => c.json({ ok: true }),
);
