import { describe, expect, it } from "vitest";

import type { RoleSourceFactory } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import { createPermDock } from "../../src/core/permdock.ts";
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
const perUser: RoleSourceFactory = (subject) => {
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
    const permdock = await createPermDock(policy, staff("u1"), {
      customRoles: (subject) => {
        seen.push(subject.principal?.id);
        return perUser(subject);
      },
    });
    expect(seen).toEqual(["u1"]);
    expect(permdock.can(permissions.asset.read, asset)).toBe(true);
    const other = await createPermDock(policy, staff("u2"), {
      customRoles: perUser,
    });
    expect(other.can(permissions.asset.read, asset)).toBe(false);
  });

  it("reads no custom roles when the factory throws, and says so", async () => {
    const events: unknown[] = [];
    const permdock = await createPermDock(policy, staff("u1"), {
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
      (await server.permdock(as("u1"))).can(permissions.asset.read, asset),
    ).toBe(true);
    expect(
      (await server.permdock(as("u2"))).can(permissions.asset.read, asset),
    ).toBe(false);
  });

  it("derives with a factory too", async () => {
    const permdock = await createPermDock(policy, staff("u1"));
    const derived = await permdock.derive({ customRoles: perUser });
    expect(derived.can(permissions.asset.read, asset)).toBe(true);
  });
});
