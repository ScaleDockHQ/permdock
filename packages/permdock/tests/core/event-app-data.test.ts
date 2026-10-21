import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  allow,
  getPermDockSync,
  definePermissions,
  definePolicy,
  membershipEvent,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  doc: resource(z.object({ id: z.string() }), { id: "id", actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [role("viewer", [allow(permissions.doc.read)])],
  subject: (user: { readonly id: string; readonly roles: string[] }) => user,
});

describe("x on sink events", () => {
  it("carries DecideOptions.x to the decision event and drops a value that is not plain JSON", () => {
    const events: unknown[] = [];
    const permdock = getPermDockSync(policy, { id: "u1", roles: ["viewer"] });
    permdock.on("decision", (event) => {
      events.push(event);
    });
    permdock.decide(
      permissions.doc.read,
      { id: "d1" },
      { x: { route: "/docs" } },
    );
    permdock.decide(
      permissions.doc.read,
      { id: "d1" },
      // SAFETY: the value tests what a caller without types can pass.
      { x: new Date() as never },
    );
    expect(
      events.map((event) =>
        typeof event === "object" && event !== null
          ? Reflect.get(event, "x")
          : undefined,
      ),
    ).toEqual([{ route: "/docs" }, undefined]);
  });

  it("checks x where an event builder takes it", () => {
    const base = {
      source: "app",
      operation: "added" as const,
      principal: { id: "u1" },
      roles: { added: ["viewer"], removed: [] },
    };
    expect(membershipEvent({ ...base, x: { requestId: "r-1" } }).x).toEqual({
      requestId: "r-1",
    });
    expect(() =>
      // SAFETY: the value tests what a caller without types can pass.
      membershipEvent({ ...base, x: { at: new Date() } as never }),
    ).toThrow("plain JSON");
  });
});
