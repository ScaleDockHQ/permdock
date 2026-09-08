import type { Policy } from 'permdock';

import express from 'express';
import { createPermDock } from 'permdock/express';

import { ownPost, permissions } from './permissions.ts';
import { memberUser, policy } from './policy.ts';

const { protect } = createPermDock(policy as Policy, {
  subject: () => memberUser,
});

export const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.patch(
  '/posts/:id',
  protect(permissions.post.update, () => ownPost),
  (_req, res) => {
    res.json({ ok: true });
  },
);

app.post(
  '/posts/:id/publish',
  protect(permissions.post.publish, () => ownPost),
  (_req, res) => {
    res.json({ ok: true });
  },
);
