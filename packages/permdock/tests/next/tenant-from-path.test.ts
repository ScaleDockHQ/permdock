import { describe, expect, it } from "vitest";

import { createPermDock, tenantFromPath } from "../../src/next/index.ts";
import {
  tenantCaller,
  tenantPermissions,
  tenantPolicy,
  tenantSlugs,
} from "../fixtures/tenant-path.ts";

const orgTenant = tenantFromPath({
  param: "org",
  resolve: (slug) => tenantSlugs[slug],
});

const { getPermDock } = createPermDock(tenantPolicy, {
  subject: () => tenantCaller,
  tenant: "o1",
});

async function answer(params: Readonly<Record<string, string | string[]>>) {
  const permdock = await getPermDock({
    tenant: await orgTenant(Promise.resolve(params)),
  });
  return {
    tenant: permdock.subject.principal?.tenant,
    create: permdock.decide(tenantPermissions.project.create).outcome,
  };
}

describe("permdock/next tenantFromPath", () => {
  it("uses the resolved id when the caller holds a membership there", async () => {
    await expect(answer({ org: "acme" })).resolves.toStrictEqual({
      tenant: "o1",
      create: "granted",
    });
  });

  it("never falls back to the factory tenant", async () => {
    for (const params of [
      { org: "globex" },
      { org: "nobody" },
      { org: ["acme"] },
      {},
    ]) {
      await expect(answer(params)).resolves.toStrictEqual({
        tenant: undefined,
        create: "denied",
      });
    }
  });
});
