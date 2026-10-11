import { describe, expect, it } from "vitest";

import { createPermDock } from "../../src/core/permdock.ts";
import { wrapPermDock } from "../../src/core/wrap.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

describe("wrapPermDock", () => {
  it("replaces members and re-applies them to tenant(), team() and derive()", async () => {
    const calls: string[] = [];
    const base = await createPermDock(policy, memberUser);
    const wrapped = wrapPermDock(base, (inner) => ({
      // SAFETY: the wrapper forwards can's arguments and result unchanged.
      can: ((...args: Parameters<typeof inner.can>) => {
        calls.push("can");
        return inner.can(...args);
      }) as typeof inner.can,
    }));
    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(wrapped.can(permissions.post.update, ownPost)).toBe(true);
    wrapped.tenant("acme").can(permissions.post.update, ownPost);
    wrapped.team("red").can(permissions.post.update, ownPost);
    (await wrapped.derive({})).can(permissions.post.update, ownPost);
    expect(calls).toEqual(["can", "can", "can", "can"]);
  });

  it("leaves the members it does not replace untouched", async () => {
    const base = await createPermDock(policy, memberUser);
    const wrapped = wrapPermDock(base, () => ({}));
    expect(wrapped.subject).toBe(base.subject);
    expect(wrapped.decide).toBe(base.decide);
  });
});
