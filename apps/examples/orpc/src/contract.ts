import { oc } from "@orpc/contract";
import { problemDetails, securityFor } from "permdock/openapi";
import { z } from "zod";

import { permissions } from "./permissions.ts";

const ok = z.object({ ok: z.literal(true) });
const byId = z.object({ id: z.string() });
const guarded = oc.errors({ FORBIDDEN: { status: 403, data: problemDetails } });

export const contract = {
  health: oc.output(ok),
  posts: {
    update: guarded.input(byId).output(ok),
    publish: guarded.input(byId).output(ok),
  },
};

/** Each operation's `security` and `x-permdock-permissions`, without the policy. */
export const security = {
  "posts.update": securityFor(permissions.post.update),
  "posts.publish": securityFor(permissions.post.publish),
};
