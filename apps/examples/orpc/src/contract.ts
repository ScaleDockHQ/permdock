import { oc } from "@orpc/contract";
import { securityFor } from "permdock/openapi";
import { z } from "zod";

import { permissions } from "./permissions.ts";

const ok = z.object({ ok: z.literal(true) });
const byId = z.object({ id: z.string() });

export const contract = {
  health: oc.output(ok),
  posts: {
    update: oc.input(byId).output(ok),
    publish: oc.input(byId).output(ok),
  },
};

/** Each operation's `security` and `x-permdock-permissions`, without the policy. */
export const security = {
  "posts.update": securityFor(permissions.post.update),
  "posts.publish": securityFor(permissions.post.publish),
};
