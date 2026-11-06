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

    it("warns once more when the lifetime is under 30 s, which no prefetch carries", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { getSnapshot } = createPermDock(policy, {
          subject: () => memberUser,
        });
        await getSnapshot({ cacheLife: { min: 0, max: 10 } });
        await getSnapshot({ cacheLife: { min: 0, max: 10 } });
        const messages = warn.mock.calls.map(([message]) => String(message));
        expect(messages).toHaveLength(2);
        expect(messages[0]).toContain("under 30 s out of every prefetch");
        expect(messages[1]).toContain("under 300 s");
      } finally {
        warn.mockRestore();
        vi.unstubAllEnvs();
      }
    });

    it("ships only the context keys the allow-list names, and warns about the rest", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { getSnapshot } = createPermDock(policy, {
          subject: () => ({
            principal: { ...memberUser },
            context: { plan: "pro", internal: "secret" },
          }),
        });
        const snapshot = await getSnapshot({ context: ["plan"] });
        expect(snapshot.subject.context).toStrictEqual({ plan: "pro" });
        const dropped = warn.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes("context drops"));
        expect(dropped).toHaveLength(1);
        expect(dropped[0]).toContain("internal");
        const whole = await getSnapshot();
        expect(whole.subject.context).toStrictEqual({
          plan: "pro",
          internal: "secret",
        });
      } finally {
        warn.mockRestore();
        vi.unstubAllEnvs();
      }
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
