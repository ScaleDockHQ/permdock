import { describe, expect, it } from "vitest";

import type { CustomRoleSourceFactory } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import { buildInstance } from "../../src/core/build-instance.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { instanceCache } from "../../src/index.ts";
import { createPermDock as createServerPermDock } from "../../src/server/index.ts";
import { customRoles, permissions, policy } from "../fixtures/named-scopes.ts";

function staff(id: string): Subject {
  return {
    principal: {
      id,
      tenant: "T",
      memberships: [
        { scope: "organization", id: "T", roles: ["mechanic"], via: "staff" },
      ],
    },
    context: {},
  };
}

const asset = { id: "a", organization_id: "T", customer_id: "c" };

/** Only u1's store holds the mechanic role; every subject gets its own source. */
const perUser: CustomRoleSourceFactory = (subject) => {
  const id = subject.principal?.id;
  return id === undefined
    ? undefined
    : {
        rolesFor: (tenant) =>
          id === "u1"
            ? customRoles.filter((role) => role.tenant === tenant)
            : [],
      };
};

describe("customRoles as a factory of the subject", () => {
  it("builds the source for the resolved subject", async () => {
    const seen: (string | undefined)[] = [];
    const permdock = getPermDockSync(policy, staff("u1"), {
      customRoles: (subject) => {
        seen.push(subject.principal?.id);
        return perUser(subject);
      },
    });
    expect(seen).toStrictEqual(["u1"]);
    expect(permdock.can(permissions.asset.read, asset)).toBe(true);
    const other = getPermDockSync(policy, staff("u2"), {
      customRoles: perUser,
    });
    expect(other.can(permissions.asset.read, asset)).toBe(false);
  });

  it("reads no custom roles when the factory throws, and says so", async () => {
    const events: unknown[] = [];
    const permdock = getPermDockSync(policy, staff("u1"), {
      customRoles: () => {
        throw new Error("no store");
      },
    });
    permdock.on("auth", (event) => {
      events.push(event);
    });
    expect(permdock.can(permissions.asset.read, asset)).toBe(false);
    expect(events).toContainEqual({
      reason: "source-threw",
      source: "customRoles",
    });
  });

  it("gives every request of a server adapter its subject's roles", async () => {
    const server = createServerPermDock(policy, {
      subject: (request: Request) =>
        staff(request.headers.get("x-user") ?? "nobody"),
      customRoles: perUser,
    });
    const as = (user: string): Request =>
      new Request("https://api.example/assets/a", {
        headers: { "x-user": user },
      });
    expect(
      (await server.getPermDock(as("u1"))).can(permissions.asset.read, asset),
    ).toBe(true);
    expect(
      (await server.getPermDock(as("u2"))).can(permissions.asset.read, asset),
    ).toBe(false);
  });

  it("derives with a factory too", async () => {
    const permdock = getPermDockSync(policy, staff("u1"));
    const derived = await permdock.derive({ customRoles: perUser });
    expect(derived.can(permissions.asset.read, asset)).toBe(true);
  });
});

describe("a custom-role factory behind an instance cache", () => {
  function counted() {
    const reads: string[] = [];
    const factory: CustomRoleSourceFactory = (subject) => {
      const source = perUser(subject);
      return source === undefined
        ? undefined
        : {
            rolesFor: (tenant, context) => {
              reads.push(subject.principal?.id ?? "");
              return source.rolesFor(tenant, context);
            },
          };
    };
    return { reads, factory };
  }

  async function check(
    sources: Parameters<typeof buildInstance>[0]["sources"],
    id: string,
    version: number,
  ): Promise<boolean> {
    const { permdock } = await buildInstance({
      policy,
      user: staff(id),
      sources,
      scope: { version: { known: version } },
    });
    return permdock.can(permissions.asset.read, asset);
  }

  it("keeps a subject's answers and never shares them with another subject", async () => {
    const { reads, factory } = counted();
    const sources = { customRoles: factory, instances: instanceCache() };
    expect(await check(sources, "u1", 1)).toBe(true);
    expect(await check(sources, "u1", 2)).toBe(true);
    expect(reads).toStrictEqual(["u1"]);
    expect(await check(sources, "u2", 1)).toBe(false);
    expect(reads).toStrictEqual(["u1", "u2"]);
  });

  it("drops a subject's answers on evict and after maxAgeMs", async () => {
    const { reads, factory } = counted();
    const time = { ms: 0 };
    const instances = instanceCache({ maxAgeMs: 1000, now: () => time.ms });
    const sources = { customRoles: factory, instances };
    await check(sources, "u1", 1);
    instances.evict("u1");
    await check(sources, "u1", 2);
    expect(reads).toStrictEqual(["u1", "u1"]);
    time.ms = 2000;
    await check(sources, "u1", 3);
    expect(reads).toStrictEqual(["u1", "u1", "u1"]);
  });

  it("reports a throwing factory each time and caches nothing for it", async () => {
    let calls = 0;
    const sources = {
      customRoles: (): undefined => {
        calls += 1;
        throw new Error("no store");
      },
      instances: instanceCache(),
    };
    for (const version of [1, 2]) {
      const { permdock } = await buildInstance({
        policy,
        user: staff("u1"),
        sources,
        scope: { version: { known: version } },
      });
      const events: unknown[] = [];
      permdock.on("auth", (event) => {
        events.push(event);
      });
      expect(permdock.can(permissions.asset.read, asset)).toBe(false);
      expect(events).toContainEqual({
        reason: "source-threw",
        source: "customRoles",
      });
    }
    expect(calls).toBe(2);
  });
});
