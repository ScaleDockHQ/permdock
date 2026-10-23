import { describe, expect, it } from "vitest";

import type { MembershipSource } from "../../src/index.ts";

import { claimsFirst, memoryVersionCache } from "../../src/index.ts";
import { createPermDock } from "../../src/server/index.ts";
import { permissions, policy } from "../fixtures/quick-start.ts";

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

function server(intent?: (request: Request) => "read" | "write" | undefined) {
  const state = { version: 3, roles: ["member"], versionReads: 0 };
  const source: MembershipSource = {
    membershipsFor: () => [],
    async version() {
      state.versionReads += 1;
      return state.version;
    },
    globalRolesFor: () => state.roles,
  };
  const kernel = createPermDock(policy, {
    subject: () => token,
    memberships: claimsFirst(source, {
      onStale: "reread",
      versions: memoryVersionCache({ maxStaleMs: 5000 }),
    }),
    ...(intent === undefined ? {} : { intent }),
  });
  return { state, kernel };
}

const request = (method: string): Request =>
  new Request("https://app.test/posts", { method });

describe("server kit intent", () => {
  it("shares version reads across GET, HEAD and OPTIONS requests", async () => {
    const { state, kernel } = server();
    for (const method of ["GET", "HEAD", "OPTIONS", "GET"]) {
      await kernel.getPermDock(request(method));
    }
    expect(state.versionReads).toBe(1);
  });

  it("reads the version live for POST and denies a revoked role", async () => {
    const { state, kernel } = server();
    await kernel.getPermDock(request("GET"));
    state.version = 4;
    state.roles = [];
    const read = await kernel.getPermDock(request("GET"));
    expect(read.can(permissions.post.list)).toBe(true);
    const write = await kernel.getPermDock(request("POST"));
    expect(state.versionReads).toBe(2);
    expect(write.can(permissions.post.list)).toBe(false);
  });

  it("lets intent(request) override the method", async () => {
    const { state, kernel } = server((r) =>
      r.headers.get("x-live") === "1" ? "write" : undefined,
    );
    await kernel.getPermDock(request("GET"));
    await kernel.getPermDock(
      new Request("https://app.test/posts", { headers: { "x-live": "1" } }),
    );
    expect(state.versionReads).toBe(2);
  });

  it("treats a throwing intent(request) as write", async () => {
    const { state, kernel } = server(() => {
      throw new Error("boom");
    });
    await kernel.getPermDock(request("GET"));
    await kernel.getPermDock(request("GET"));
    expect(state.versionReads).toBe(2);
  });
});
