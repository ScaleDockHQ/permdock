import { describe, expect, it } from "vitest";

import type { PermDockWrap } from "../../src/core/wrap.ts";

import { createPermDock } from "../../src/core/permdock.ts";
import { composeWraps, wrapPermDock } from "../../src/core/wrap.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

describe("wrapPermDock", () => {
  it("replaces members and re-applies them to tenant(), team() and derive()", async () => {
    const calls: string[] = [];
    const base = createPermDock(policy, memberUser);
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
    const base = createPermDock(policy, memberUser);
    const wrapped = wrapPermDock(base, () => ({}));
    expect(wrapped.subject).toBe(base.subject);
    expect(wrapped.decide).toBe(base.decide);
  });
});

describe("composeWraps", () => {
  it("applies otel first, then wrap", async () => {
    const order: string[] = [];
    const base = createPermDock(policy, memberUser);
    const composed = composeWraps(
      (permdock) => {
        order.push("otel");
        return permdock;
      },
      (permdock) => {
        order.push("wrap");
        return permdock;
      },
    );
    expect(composed?.(base)).toBe(base);
    expect(order).toEqual(["otel", "wrap"]);
  });

  it("returns whichever one is given", () => {
    const only: PermDockWrap = (permdock) => permdock;
    expect(composeWraps(only, undefined)).toBe(only);
    expect(composeWraps(undefined, only)).toBe(only);
    expect(composeWraps(undefined, undefined)).toBeUndefined();
  });
});
