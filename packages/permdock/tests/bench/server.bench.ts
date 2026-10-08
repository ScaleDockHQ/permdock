import { test } from "vitest";

import {
  definePermissions,
  listPermissions,
  resource,
} from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";
import { createServerKernel } from "../../src/server/create.ts";
import { createPermDock as createTrpcPermDock } from "../../src/trpc/create.ts";

const RESOURCES = 200;

const permissions = definePermissions(
  Object.fromEntries(
    Array.from({ length: RESOURCES }, (_, index) => [
      `r${String(index)}`,
      resource({ collection: ["list", "create", "export"] }),
    ]),
  ),
);
const policy = definePolicy(permissions, {
  roles: [
    role(
      "member",
      listPermissions(permissions).map((leaf) => allow(leaf)),
    ),
  ],
  subject: (user: { readonly id: string } | null) =>
    user === null ? null : { id: user.id, roles: ["member"] },
});

const byType = JSON.stringify({
  evaluations: Array.from({ length: 100 }, (_, index) => ({
    action: { name: "export" },
    resource: { type: `r${String(RESOURCES - 1 - index)}` },
  })),
});
const byKey = JSON.stringify({
  evaluations: Array.from({ length: 100 }, (_, index) => ({
    action: { name: `r${String(RESOURCES - 1 - index)}.export` },
  })),
});

const kernel = createServerKernel(policy, { subject: () => ({ id: "u1" }) });
const { POST } = kernel.permdockHandler();
const trpc = createTrpcPermDock(policy, { subject: () => ({ id: "u1" }) });

const post = (body: string): Request =>
  new Request("https://api.test/permdock", { method: "POST", body });

test("evaluations, 100 items over 600 permissions", async ({ bench }) => {
  await bench.compare(
    bench("by resource type and action", async () => {
      await POST(post(byType));
    }),
    bench("by permission key", async () => {
      await POST(post(byKey));
    }),
    bench("tRPC permdockHandler, by permission key", async () => {
      await trpc.permdockHandler(post(byKey));
    }),
  );
});
