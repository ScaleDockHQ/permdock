import { cacheLife, cacheTag } from "next/cache.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPermDock, snapshotTag } from "../../src/next/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

vi.mock(import("next/cache.js"), async (original) => ({
  ...(await original()),
  cacheLife: vi.fn<(...args: unknown[]) => void>(),
  cacheTag: vi.fn<(...tags: string[]) => void>(),
}));

describe("get snapshot", () => {
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

    it("warns once in development about a lifetime under 300 s", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { getSnapshot } = createPermDock(policy, {
          subject: () => memberUser,
        });
        await getSnapshot({ cacheLife: { max: 60 } });
        await getSnapshot({ cacheLife: { max: 60 } });
        expect(cacheLife).toHaveBeenCalledWith({ stale: 60 });
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]?.[0]).toContain("caches for 60 s");
      } finally {
        warn.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it("stays quiet about a short lifetime outside development", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { getSnapshot } = createPermDock(policy, {
          subject: () => memberUser,
        });
        await getSnapshot({ cacheLife: { max: 60 } });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
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
});
