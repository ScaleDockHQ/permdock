import { cacheLife, cacheTag } from "next/cache.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPermDock, snapshotTag } from "../../src/next/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

vi.mock(import("next/cache.js"), async (original) => ({
  ...(await original()),
  cacheLife: vi.fn<(...args: unknown[]) => void>(),
  cacheTag: vi.fn<(...tags: string[]) => void>(),
}));

afterEach(() => {
  vi.mocked(cacheLife).mockReset();
  vi.mocked(cacheTag).mockReset();
});

describe("getSnapshot", () => {
  it("returns the snapshot and sets its lifetime and tags in the caller's scope", async () => {
    const { getSnapshot } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const snapshot = await getSnapshot({
      include: [permissions.post],
      tags: ["org:acme"],
    });
    expect(snapshot.v).toBe(1);
    expect(snapshot.grants.length).toBeGreaterThan(0);
    expect(cacheLife).toHaveBeenCalledWith({ stale: 300 });
    expect(cacheTag).toHaveBeenCalledWith(
      snapshotTag(memberUser.id),
      "org:acme",
    );
  });

  it("tags an anonymous snapshot", async () => {
    const { getSnapshot } = createPermDock(policy, { subject: () => null });
    await getSnapshot();
    expect(cacheTag).toHaveBeenCalledWith("permdock:anon");
  });

  it("names the missing cache scope", async () => {
    vi.mocked(cacheLife).mockImplementation(() => {
      throw new Error(
        '`cacheLife()` can only be called inside a "use cache" function.',
      );
    });
    const { getSnapshot } = createPermDock(policy, {
      subject: () => memberUser,
    });
    await expect(getSnapshot()).rejects.toThrow(/'use cache: private'/u);
  });
});
