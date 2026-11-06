import type { PermDock, VocabularyOf } from "permdock";
import type { PermDockPlugin } from "permdock/cli";
import type { RlsPluginOptions } from "permdock/cli/plugins/rls";
import type { Seeds } from "permdock/seeds";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";
import { definePermDock } from "permdock/app";
import { definePlugin } from "permdock/cli";
import { rls } from "permdock/cli/plugins/rls";
import { defineSeeds } from "permdock/seeds";
import { z } from "zod";

const doc = z.object({ id: z.string(), orgId: z.string() });

const permissions = definePermissions({
  doc: resource(doc, {
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: (user: { readonly id: string } | null) => user,
  roles: [role("admin", [allow(permissions.doc.read)], { on: "tenant" })],
});

const app = definePermDock(policy, { profile: "dev" });

type Vocabulary = VocabularyOf<typeof policy>;

/** `definePermDock` members answer `PermDock` of the policy vocabulary. */
export const getter: (user: unknown) => Promise<PermDock<Vocabulary>> =
  app.getPermDock;
export const fromClaims: (
  claims: Readonly<Record<string, unknown>>,
) => Promise<PermDock<Vocabulary>> = app.fromClaims;

export const seeds: Seeds = defineSeeds(policy, {
  defaults: {
    roles: [
      {
        key: "admin",
        scope: "tenant",
        grants: [permissions.doc.read, permissions.doc.update],
      },
    ],
  },
});

export const rlsOptions: RlsPluginOptions = { target: "sql", out: "out.sql" };

export const rlsPlugin: PermDockPlugin = rls(rlsOptions);

export const echo: PermDockPlugin = definePlugin({
  name: "echo",
  version: "1",
  plan: () => [{ id: "a", out: "a.txt" }],
  emit: () => [{ path: "a.txt", contents: "x" }],
});

defineSeeds(policy, {
  defaults: {
    // @ts-expect-error a permission key string is not a permission reference
    roles: [{ key: "admin", scope: "tenant", grants: ["doc.read"] }],
  },
});

// @ts-expect-error a plugin option that does not exist
export const badOptions: RlsPluginOptions = { outFile: "x" };
