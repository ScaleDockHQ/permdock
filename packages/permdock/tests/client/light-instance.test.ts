import { describe, expect, it, vi } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";

import { eagerEvaluator } from "../../src/client/evaluator-eager.ts";
import { lightInstance } from "../../src/client/light-instance.ts";
import { createStore } from "../../src/client/store-core.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

function snapshot() {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const built = getPermDockSync(policy as never, memberUser).snapshot();
  if (built instanceof Promise) {
    throw new TypeError("expected JSON snapshot");
  }
  return built;
}

describe(lightInstance, () => {
  it("denies every check and keeps the snapshot reads", () => {
    const built = snapshot();
    const light = lightInstance(built, {});
    expect(light.can(permissions.post.list)).toBe(false);
    expect(light.decide(permissions.post.list)).toMatchObject({
      outcome: "denied",
    });
    expect(light.snapshot()).toBe(built);
    expect(light.roles).toStrictEqual(built.vocabulary?.roles ?? {});
    expect(light.tenant("o_1").snapshot()).toBe(built);
  });

  it("answers the snapshot reads as the evaluator does, without expanding the grants", () => {
    const built = snapshot();
    const light = lightInstance(built, {});
    const full = eagerEvaluator.build()?.(built, {});
    expect(light.memberships()).toStrictEqual(full?.memberships());
    expect(light.tenants()).toStrictEqual(full?.tenants());
    expect(light.heldRoles()).toStrictEqual(full?.heldRoles());
    expect(light.subject).toStrictEqual(full?.subject);
  });
});

describe("the eager evaluator", () => {
  it("builds at once and resolves its load", async () => {
    expect(eagerEvaluator.build()).toBeTypeOf("function");
    await expect(eagerEvaluator.load()).resolves.toBeUndefined();
  });
});

describe("a store whose evaluator fails to load", () => {
  it("rejects loading(), then retries on the next call", async () => {
    let attempts = 0;
    const store = createStore(
      { snapshot: snapshot() },
      {
        build: () => undefined,
        load: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new Error("offline"))
            : Promise.resolve();
        },
      },
    );
    await expect(store.loading()).rejects.toThrow("offline");
    await expect(store.loading()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});

describe("store.quick", () => {
  it("leaves a key listed under endpoint to the evaluator", () => {
    const store = createStore(
      {
        snapshot: {
          ...snapshot(),
          typeLevel: { granted: [], endpoint: [permissions.post.read.key] },
        },
      },
      eagerEvaluator,
    );
    expect(store.quick(permissions.post.read)).toBeUndefined();
    expect(store.quick(permissions.post.update)?.outcome).toBe("denied");
  });
});

describe("a store whose instance throws", () => {
  it("answers a validation denial", () => {
    const store = createStore(
      { snapshot: snapshot() },
      {
        // SAFETY: only `decide` is read by the check under test, and it throws.
        build: () => () =>
          ({
            decide: () => {
              throw new Error("bad row");
            },
          }) as unknown as PermDock,
        load: () => Promise.resolve(),
      },
    );
    const state = store.permissionState(permissions.post.update, {});
    expect(state.allowed).toBe(false);
    expect(state.decision.outcome).toBe("denied");
  });
});

describe("a closure grant without an endpoint", () => {
  it("reports server-only", () => {
    const store = createStore(
      { snapshot: snapshot() },
      {
        // SAFETY: only `decide` is read by the check under test.
        build: () => () =>
          ({
            decide: () => ({
              outcome: "denied",
              denials: [{ role: "member", reason: "opaque-condition" }],
              alternatives: [],
            }),
          }) as unknown as PermDock,
        load: () => Promise.resolve(),
      },
    );
    const state = store.permissionState(permissions.post.update, { id: "p1" });
    expect(state).toMatchObject({ allowed: false, status: "server-only" });
  });
});

describe("a subscriber that throws", () => {
  it("is reported to console.error when the runtime has no reportError", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "reportError");
    Object.defineProperty(globalThis, "reportError", {
      value: undefined,
      configurable: true,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const store = createStore({ snapshot: snapshot() }, eagerEvaluator);
      store.subscribe(() => {
        throw new Error("listener");
      });
      store.replace(snapshot());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "reportError");
      } else {
        Object.defineProperty(globalThis, "reportError", original);
      }
    }
  });
});
