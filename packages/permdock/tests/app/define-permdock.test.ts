import { describe, expect, it } from "vitest";

import { definePermDock } from "../../src/app/index.ts";
import { permdockFor } from "../../src/better-supabase/index.ts";
import { appOf } from "../../src/core/app.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  instanceCache,
  memorySubjectCache,
  memoryVersionCache,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  post: resource({ actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.post.read)])],
  subject: (user: { id: string; roles: string[] } | null) => user,
});

describe(definePermDock, () => {
  it("is a policy that carries getPermDock, fromClaims, fromApiKey, sources and evict", async () => {
    const app = definePermDock(policy);
    expect(app.fingerprint).toBe(policy.fingerprint);
    expect(appOf(app)?.profile).toBe("prod");
    const permdock = await app.getPermDock({ id: "u1", roles: ["member"] });
    expect(permdock.can(permissions.post.read, { id: "p1" })).toBe(true);
    expect(Object.keys(app)).not.toContain("getPermDock");
  });

  it("maps verified claims through the claims option", async () => {
    const app = definePermDock(policy, {
      claims: { id: "user.id", roles: "user.roles" },
    });
    const granted = await app.fromClaims({
      user: { id: "u1", roles: ["member"] },
    });
    expect(granted.can(permissions.post.read, { id: "p1" })).toBe(true);
    const anonymous = await app.fromClaims({ user: { roles: ["member"] } });
    expect(anonymous.subject.principal).toBeNull();
    expect(anonymous.can(permissions.post.read, { id: "p1" })).toBe(false);
  });

  it("resolves an API key through credentials and answers anonymous for an unknown one", async () => {
    const app = definePermDock(policy, {
      credentials: { verifier: { verify: () => null } },
    });
    const permdock = await app.fromApiKey("pdk_nope_nope");
    expect(permdock.subject.principal).toBeNull();
    await expect(definePermDock(policy).fromApiKey("k")).rejects.toThrow(
      /credentials/u,
    );
  });

  it("evicts a principal from the instance, version and subject caches", async () => {
    const instances = instanceCache();
    const versions = memoryVersionCache({ maxStaleMs: 1000 });
    const subjects = memorySubjectCache();
    versions.seed("u1", 3);
    await subjects.seed({
      id: "u1",
      active: true,
      roles: [],
      memberships: [],
      customRoles: [],
      authzVersion: 3,
    });
    const app = definePermDock(policy, { instances, versions, subjects });
    await app.evict("u1");
    expect(await subjects.record("u1", 3)).toBeNull();
    expect(versions.stats().evictions).toBe(1);
    expect(instances.stats().evictions).toBe(1);
  });

  it("shares one sources object per version cache", () => {
    const versions = memoryVersionCache({ maxStaleMs: 1000 });
    const app = definePermDock(policy, { versions });
    expect(app.sources()).toBe(app.sources(versions));
    expect(app.sources(memoryVersionCache({ maxStaleMs: 1000 }))).not.toBe(
      app.sources(),
    );
  });

  it("feeds permdockFor the definition's caches and sources", async () => {
    const instances = instanceCache();
    const app = definePermDock(policy, { instances });
    const resolve = permdockFor({ policy: app });
    expect(resolve.sources().instances).toBe(instances);
    const subject = { principal: { id: "u1", roles: ["member"] }, context: {} };
    const permdock = await resolve(subject);
    expect(permdock.subject.principal?.id).toBe("u1");
  });

  describe("forClient", () => {
    type Client = { readonly name: string };
    const sourcesFor = (log: string[]) => (client: Client) => {
      log.push(client.name);
      return { memberships: { name: client.name, membershipsFor: () => [] } };
    };

    it("calls sources once per client and answers the same bound definition sources", () => {
      const log: string[] = [];
      const app = definePermDock(policy, { sources: sourcesFor(log) });
      const a: Client = { name: "a" };
      const b: Client = { name: "b" };
      expect(appOf(app.forClient(a))?.memberships).toBe(
        appOf(app.forClient(a))?.memberships,
      );
      expect(appOf(app.forClient(a))?.memberships).not.toBe(
        appOf(app.forClient(b))?.memberships,
      );
      expect(log).toStrictEqual(["a", "b"]);
    });

    it("binds memberships, keeps the caches and still builds instances", async () => {
      const instances = instanceCache();
      const app = definePermDock(policy, {
        instances,
        sources: sourcesFor([]),
      });
      const bound = app.forClient({ name: "a" });
      expect(appOf(bound)?.instances).toBe(instances);
      expect(bound.fingerprint).toBe(policy.fingerprint);
      const permdock = await bound.getPermDock({ id: "u1", roles: ["member"] });
      expect(permdock.can(permissions.post.read, { id: "p1" })).toBe(true);
      expect(bound.sources().memberships).toBeDefined();
      expect(app.sources().memberships).toBeUndefined();
    });

    it("feeds permdockFor the bound sources", () => {
      const app = definePermDock(policy, { sources: sourcesFor([]) });
      const resolve = permdockFor({ policy: app.forClient({ name: "a" }) });
      expect(resolve.sources().memberships).toBeDefined();
    });

    it("accepts a test double as the client", () => {
      const app = definePermDock(policy, {
        sources: (client: { readonly rpc: () => void }) => {
          client.rpc();
          return {};
        },
      });
      let calls = 0;
      app.forClient({
        rpc: () => {
          calls += 1;
        },
      });
      expect(calls).toBe(1);
    });

    it("throws a TypeError that names the option when sources is not set", () => {
      const app = definePermDock(policy);
      expect(() => app.forClient({})).toThrow(
        new TypeError(
          "PermDock: forClient needs the sources option of definePermDock",
        ),
      );
    });

    it("types the client from the sources option", () => {
      const app = definePermDock(policy, { sources: sourcesFor([]) });
      // @ts-expect-error the client has no name
      app.forClient({});
      expect(app.forClient({ name: "a" })).toBeDefined();
    });
  });
});
