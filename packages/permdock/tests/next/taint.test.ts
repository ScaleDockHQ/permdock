import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPermDock } from "../../src/next/index.ts";
import { memberUser, policy } from "../fixtures/quick-start.ts";

const { taint } = vi.hoisted(() => ({
  taint: vi.fn<(message: string, object: object) => void>(),
}));

vi.mock(import("react"), async (original) => {
  const actual = await original();
  // SAFETY: the installed React has no experimental taint export; the test adds the one Next.js's React has.
  return {
    ...actual,
    experimental_taintObjectReference: taint,
  } as typeof actual;
});

vi.mock(import("next/cache.js"), async (original) => ({
  ...(await original()),
  io: vi.fn<() => Promise<void>>(async () => undefined),
}));

describe("permdock/next taint", () => {
  afterEach(() => {
    taint.mockClear();
  });

  it("keeps the options and each instance on the server when React has taint", async () => {
    expect(Reflect.get(React, "experimental_taintObjectReference")).toBeTypeOf(
      "function",
    );
    const next = createPermDock(policy, { subject: () => memberUser });
    expect(taint).toHaveBeenCalledTimes(1);
    expect(taint.mock.calls[0]?.[0]).toContain("PermDock options");
    const instance = await next.getPermDock();
    expect(instance.subject.principal).not.toBeNull();
    const tainted = taint.mock.calls.map(([message]) => message);
    expect(
      tainted.some((message) => message.includes("PermDock instance")),
    ).toBe(true);
    expect(taint.mock.calls.at(-1)?.[1]).toBe(instance);
  });

  it("does not stop a request when taint throws", async () => {
    taint.mockImplementation(() => {
      throw new Error("already tainted");
    });
    const next = createPermDock(policy, { subject: () => memberUser });
    await expect(next.getPermDock()).resolves.toBeDefined();
    taint.mockReset();
  });
});
