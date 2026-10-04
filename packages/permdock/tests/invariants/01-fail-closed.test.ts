import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { subjectFromSupabase } from "../../src/supabase/index.ts";
import { reasonOf } from "../fixtures/decisions.ts";
import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const OUTCOMES = new Set(["granted", "denied", "approval-required"]);

const Other = z.object({ id: z.string() });
const foreign = definePermissions({
  note: resource(Other, { id: "id", actions: ["read"] }),
});

describe("invariant 1: fail-closed", () => {
  it("denies a role the policy does not define", async () => {
    const permdock = await createPermDock(policy, {
      id: "u1",
      orgId: "o1",
      roles: ["superuser"],
    });
    expect(permdock.can(permissions.post.read, ownPost)).toBe(false);
  });

  it("denies when the subject mapping throws", async () => {
    const throwing = definePolicy(permissions, {
      roles: [role("member", [allow(permissions.post.read)])],
      subject: (): { id: string; roles: string[] } => {
        throw new Error("token parse failed");
      },
    });
    const permdock = await createPermDock(throwing, { id: "u1" });
    expect(permdock.can(permissions.post.read, ownPost)).toBe(false);
  });

  it("denies when a grant closure throws", async () => {
    const throwing = definePolicy(permissions, {
      roles: [
        role("member", [
          allow(permissions.post.update, (): boolean => {
            throw new Error("lookup failed");
          }),
        ]),
      ],
      subject: (user: { id: string; roles: string[] }) => user,
    });
    const permdock = await createPermDock(throwing, {
      id: "u1",
      roles: ["member"],
    });
    const decision = permdock.decide(permissions.post.update, ownPost);
    expect(decision.outcome).toBe("denied");
    expect(reasonOf(decision)).toBe("closure-error");
  });

  it("denies a row that fails the resource schema", async () => {
    const permdock = await createPermDock(policy, memberUser);
    const decision = permdock.decide(permissions.post.update, {
      ...ownPost,
      published: "yes",
    });
    expect(decision.outcome).toBe("denied");
    expect(reasonOf(decision)).toBe("validation");
  });

  it("denies an actor that carries no delegation", async () => {
    const permdock = await createPermDock(policy, memberUser, {
      actor: { id: "agent-1", kind: "agent" },
    });
    const decision = permdock.decide(permissions.post.read, ownPost);
    expect(decision.outcome).toBe("denied");
    expect(reasonOf(decision)).toBe("no-delegation");
  });

  it("denies a support or impersonation actor no policy delegation names", async () => {
    for (const actor of [
      { id: "admin-1", kind: "support", sessionId: "s-1", readOnly: true },
      { id: "admin-1", kind: "impersonation" },
    ]) {
      const permdock = await createPermDock(policy, memberUser, { actor });
      const decision = permdock.decide(permissions.post.read, ownPost);
      expect(reasonOf(decision)).toBe("no-delegation");
    }
  });

  it("denies a Supabase token whose act names an unknown kind", () => {
    const subject = subjectFromSupabase({
      sub: "u1",
      role: "authenticated",
      act: { kind: "root", sub: "admin-1" },
    });
    expect(subject.principal).toBeNull();
  });

  it("denies a permission from another catalogue", async () => {
    const permdock = await createPermDock(policy, adminUser);
    expect(permdock.can(foreign.note.read, { id: "n1" })).toBe(false);
  });

  it("denies an anonymous caller", async () => {
    const permdock = await createPermDock(policy, null);
    expect(permdock.can(permissions.post.read, ownPost)).toBe(false);
  });

  it("never throws from can() on hostile input", async () => {
    const permdock = await createPermDock(policy, adminUser);
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      "post.read",
      {},
      { key: "post.nope" },
      Object.create(null),
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    ];
    const rows: unknown[] = [
      undefined,
      null,
      "row",
      [],
      { id: 1 },
      new Proxy(
        {},
        {
          get() {
            throw new Error("trap");
          },
        },
      ),
    ];
    for (const permission of hostile) {
      for (const row of rows) {
        // SAFETY: deliberately not a permission reference, to probe the runtime guard.
        const call = () => permdock.can(permission as never, row as never);
        expect(call).not.toThrow();
        expect(call()).toBe(false);
      }
    }
    for (const row of rows.slice(1)) {
      // SAFETY: deliberately not a row of the resource schema.
      expect(permdock.can(permissions.post.update, row as never)).toBe(false);
    }
  });

  it("only ever returns the three outcomes", async () => {
    const users = [null, memberUser, adminUser];
    const rows = [undefined, ownPost, { ...ownPost, authorId: "u9" }, {}];
    const leaves = [
      permissions.post.read,
      permissions.post.update,
      permissions.post.delete,
      permissions.post.publish,
    ];
    for (const user of users) {
      const permdock = await createPermDock(policy, user);
      for (const leaf of leaves) {
        for (const row of rows) {
          const decision = permdock.decide(leaf, row);
          expect({ leaf: leaf.key, outcome: decision.outcome }).toEqual({
            leaf: leaf.key,
            outcome: expect.toSatisfy((value: string) => OUTCOMES.has(value)),
          });
        }
      }
    }
  });
});
