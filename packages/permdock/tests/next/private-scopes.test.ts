import { io } from "next/cache.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { MembershipSource } from "../../src/index.ts";

import { claimsFirst, memoryVersionCache } from "../../src/index.ts";
import { createPermDock } from "../../src/next/index.ts";
import { ownPost, permissions, policy } from "../fixtures/quick-start.ts";

const order: string[] = [];

vi.mock(import("next/cache.js"), async (original) => ({
  ...(await original()),
  io: vi.fn<() => Promise<void>>(async () => {
    order.push("io");
  }),
}));

function database() {
  const state = { version: 3, roles: ["member"], versionReads: 0 };
  const source: MembershipSource = {
    membershipsFor: () => [],
    async version() {
      state.versionReads += 1;
      return state.version;
    },
    globalRolesFor: () => state.roles,
  };
  return { state, source };
}

const token = {
  principal: {
    id: "u1",
    orgId: "o1",
    roles: ["member"],
    memberships: [],
    authzVersion: 3,
  },
  context: {},
};

function factory(source: MembershipSource) {
  return createPermDock(policy, {
    subject: () => token,
    memberships: claimsFirst(source, {
      onStale: "reread",
      versions: memoryVersionCache({ maxStaleMs: 5000 }),
    }),
  });
}

/**
 * A `'use cache: private'` island: its own scope, so React.cache does not
 * dedupe.
 */
async function island(
  getPermDock: ReturnType<typeof factory>["getPermDock"],
  depth: number,
): Promise<boolean> {
  if (depth > 0) {
    return island(getPermDock, depth - 1);
  }
  const permdock = await getPermDock();
  return permdock.can(permissions.post.list);
}

describe("permdock/next in private cache scopes", () => {
  afterEach(() => {
    order.length = 0;
    vi.restoreAllMocks();
  });

  it("makes one version read for 10 nested islands", async () => {
    const { state, source } = database();
    const { getPermDock } = factory(source);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, depth) => island(getPermDock, depth)),
    );
    expect(answers.every(Boolean)).toBe(true);
    expect(state.versionReads).toBe(1);
  });

  it("reads no clock before io() resolves", async () => {
    const { source } = database();
    const { getPermDock } = factory(source);
    const now = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => {
      order.push("now");
      return now();
    });
    await getPermDock();
    expect(vi.mocked(io)).toHaveBeenCalled();
    expect(order.indexOf("io")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("now")).toBeGreaterThan(order.indexOf("io"));
  });

  it("reads the version live in protectAction and denies a revoked role", async () => {
    const { state, source } = database();
    const { getPermDock, protectAction } = factory(source);
    await getPermDock();
    expect(state.versionReads).toBe(1);
    state.version = 4;
    state.roles = [];
    expect((await getPermDock()).can(permissions.post.list)).toBe(true);
    expect(state.versionReads).toBe(1);
    const rename = protectAction(permissions.post.update, {
      input: z.object({ id: z.string() }),
      data: () => ownPost,
    })(() => "renamed");
    const result = await rename({ id: "p1" });
    expect(state.versionReads).toBe(2);
    expect(result).toMatchObject({ ok: false, problem: { status: 403 } });
  });
});
