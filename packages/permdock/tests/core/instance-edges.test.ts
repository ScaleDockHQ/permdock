import { describe, expect, it } from "vitest";

import { principal } from "../../src/conditions/refs.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { memorySink } from "../../src/core/sink.ts";
import { policy, tree } from "../fixtures/org-tree.ts";

describe("instance edges", () => {
  it("answers checks, isolates throwing listeners and sinks, signs snapshots and simulates", async () => {
    const sink = memorySink({ capacity: 8 });
    const throwingSink = {
      write(): void {
        throw new Error("sink");
      },
    };
    const permdock = await createPermDock(
      policy,
      { id: "u1" },
      {
        sink,
        actor: { id: "c1", kind: "oauth-client" },
        delegation: { authorizationDetails: [{ type: "post" }] },
        session: "s1",
        expiresAt: 9_999_999_999,
      },
    );
    expect(
      permdock.assert(tree.post.read, { id: "p1", authorId: "u1", orgId: "o1" })
        .outcome,
    ).toBe("granted");
    expect(
      permdock.can(tree.post.update, {
        current: { id: "p1", authorId: "u1", orgId: "o1" },
        next: { id: "p1", authorId: "u1", orgId: "o1" },
      }),
    ).toBe(true);
    expect(
      permdock.can(tree.post.update, {
        id: "p1",
        authorId: "nope",
        orgId: "o1",
      }),
    ).toBe(false);
    expect(permdock.filter(tree.post.read, []).length).toBe(0);
    expect(permdock.where(tree.org.read).partial).toBe(false);
    const decisions: unknown[] = [];
    const approvals: unknown[] = [];
    const errors: unknown[] = [];
    const off = permdock.on("decision", (event) => {
      decisions.push(event);
    });
    permdock.on("approval", (event) => {
      approvals.push(event);
    });
    permdock.on("error", (error) => {
      errors.push(error);
    });
    permdock.on("denied", () => {
      throw new Error("denied-handler");
    });
    expect(permdock.can(tree.org.read, { id: "o1" })).toBe(false);
    off();
    const signed = await permdock.snapshot({
      tenants: "all",
      include: [tree.post],
      audience: "ads",
      signer: {
        sign: async () => "jws",
      },
    });
    expect(signed).toBe("jws");
    const json = permdock.snapshot();
    if (json instanceof Promise) {
      throw new Error("expected json");
    }
    expect(json.expiresAt).toBe(9_999_999_999);
    expect(permdock.memberships()).toEqual([]);
    expect(permdock.heldRoles().map((item) => item.key)).toEqual(["member"]);
    // Every scoped role grants only post.read, which the global member holds.
    expect(permdock.assignableRoles().map((item) => item.key)).toEqual([
      "viewer",
      "lead",
      "owner",
    ]);
    expect(permdock.assignablePermissions()).toEqual([]);
    expect(
      permdock
        .team("t1")
        .can(tree.post.read, { id: "p1", authorId: "u1", orgId: "o1" }),
    ).toBe(true);
    const thenableSink = {
      write(): Promise<void> {
        return Promise.reject(new Error("async-sink"));
      },
    };
    const leakingAsync = await createPermDock(
      policy,
      { id: "u1" },
      { sink: thenableSink },
    );
    leakingAsync.can(tree.post.read, { id: "p1", authorId: "u1", orgId: "o1" });
    const leaking = await createPermDock(
      policy,
      { id: "u1" },
      { sink: throwingSink },
    );
    leaking.on("error", (error) => {
      errors.push(error);
    });
    leaking.can(tree.post.read, { id: "p1", authorId: "u1", orgId: "o1" });
    expect(errors.length).toBeGreaterThan(0);
    const preview = permdock.simulate({
      memberships: [{ tenant: "o1", roles: ["viewer"] }],
      tenant: "o1",
    });
    if (Array.isArray(preview)) {
      throw new Error("expected instance");
    }
    expect(preview.tenants()).toEqual(["o1"]);
  });

  it("filters out rows whose grant needs approval", async () => {
    expect(
      (
        await createPermDock(
          definePolicy(tree, {
            roles: [
              role("member", [
                allow(tree.post.delete, {
                  where: { authorId: principal.id },
                  approval: "human",
                }),
              ]),
            ],
            subject: () => ({ id: "u1", roles: ["member"] }),
          }),
          { id: "u1" },
        )
      ).filter(tree.post.delete, [{ id: "p1", authorId: "u1", orgId: "o1" }]),
    ).toEqual([]);
  });
});
