import { describe, expect, it } from "vitest";

import { createPermDock, tenantFromPath } from "../../src/server/index.ts";
import {
  UNRESOLVED_TENANT,
  pathParam,
  resolveTenantSlug,
} from "../../src/server/tenant-from-path.ts";
import {
  tenantCaller as caller,
  tenantPermissions as permissions,
  tenantPolicy,
  tenantSlugs as slugs,
} from "../fixtures/tenant-path.ts";

function tenantOf(url: string, resolve = (slug: string) => slugs[slug]) {
  const { getPermDock } = createPermDock(tenantPolicy, {
    subject: () => caller,
    tenant: tenantFromPath({ path: "/orgs/:org", param: "org", resolve }),
  });
  return getPermDock(new Request(url)).then((permdock) => ({
    tenant: permdock.subject.principal?.tenant,
    create: permdock.decide(permissions.project.create).outcome,
  }));
}

describe(tenantFromPath, () => {
  it("uses the resolved id when the caller holds a membership there", async () => {
    await expect(
      tenantOf("https://api.test/orgs/acme/mcp"),
    ).resolves.toStrictEqual({ tenant: "o1", create: "granted" });
  });

  it("gives no tenant for a tenant the caller holds no membership in", async () => {
    await expect(
      tenantOf("https://api.test/orgs/globex/mcp"),
    ).resolves.toStrictEqual({ tenant: undefined, create: "denied" });
  });

  it("never falls back to the token's tenant for a slug that resolves to nothing", async () => {
    await expect(
      tenantOf("https://api.test/orgs/nobody/mcp"),
    ).resolves.toStrictEqual({ tenant: undefined, create: "denied" });
    await expect(
      tenantOf("https://api.test/orgs/acme", () => {
        throw new Error("down");
      }),
    ).resolves.toStrictEqual({ tenant: undefined, create: "denied" });
    await expect(
      tenantOf("https://api.test/orgs/%E0%A4%A", () => "o1"),
    ).resolves.toStrictEqual({ tenant: undefined, create: "denied" });
  });

  it("leaves a path outside the template to the subject's own tenant", async () => {
    await expect(tenantOf("https://api.test/health")).resolves.toStrictEqual({
      tenant: "o1",
      create: "granted",
    });
  });

  it("resolves the slug once per request", async () => {
    let reads = 0;
    const { getPermDock } = createPermDock(tenantPolicy, {
      subject: () => caller,
      tenant: tenantFromPath({
        path: "/orgs/:org",
        param: "org",
        resolve: (slug) => {
          reads += 1;
          return slugs[slug];
        },
      }),
    });
    const request = new Request("https://api.test/orgs/acme/mcp");
    await getPermDock(request);
    await getPermDock(request);
    expect(reads).toBe(1);
  });

  it("throws at setup on a template that does not name the param once", () => {
    for (const path of ["/orgs/:id", "orgs/:org", "/:org/:org"]) {
      expect(() =>
        tenantFromPath({ path, param: "org", resolve: () => null }),
      ).toThrow(TypeError);
    }
  });
});

describe(pathParam, () => {
  it("matches the template as a prefix of the path", () => {
    const match = pathParam("/orgs/:org/projects/:id", "org");
    expect(match("/orgs/acme/projects/p1/edit")).toBe("acme");
    expect(match("/orgs/acme")).toBeUndefined();
    expect(match("/teams/acme/projects/p1")).toBeUndefined();
    expect(pathParam("/orgs/:org", "org")("/orgs//mcp")).toBe("");
  });
});

describe(resolveTenantSlug, () => {
  it("answers the unresolved tenant for anything but an id", async () => {
    for (const answer of [null, undefined, "", 7, "x".repeat(257)]) {
      // SAFETY: the resolver deliberately answers values outside its type.
      const resolve = () => answer as string | null;
      await expect(resolveTenantSlug(resolve, "acme")).resolves.toBe(
        UNRESOLVED_TENANT,
      );
    }
    await expect(resolveTenantSlug(() => "o1", ["acme"])).resolves.toBe(
      UNRESOLVED_TENANT,
    );
    await expect(resolveTenantSlug(async () => "o1", "acme")).resolves.toBe(
      "o1",
    );
  });
});
