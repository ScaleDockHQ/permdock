import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceCall } from "../../src/index.ts";
import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import { sourceMemo } from "../../src/core/source-memo.ts";
import { postgrestSources } from "../../src/supabase/index.ts";

const client: SupabaseRpcClient = {
  schema: () => ({
    async rpc(fn) {
      if (fn === "authz_version_for") {
        return { data: 3, error: null };
      }
      return {
        data: {
          id: "u1",
          active: true,
          roles: [],
          memberships: [],
          customRoles: [],
        },
        error: null,
      };
    },
  }),
};

describe("postgrestSources onSourceCall", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports each read with its duration and whether the memo answered it", async () => {
    const calls: SourceCall[] = [];
    const sources = postgrestSources(client, {
      onSourceCall: (call) => {
        calls.push(call);
      },
    });
    const memo = sourceMemo();
    await sources.memberships.version?.({ id: "u1" }, { memo });
    await sources.memberships.version?.({ id: "u1" }, { memo });
    expect(calls.map(({ method, cached }) => [method, cached])).toStrictEqual([
      ["permdock.authz_version_for", false],
      ["permdock.authz_version_for", true],
    ]);
    expect(calls.every((call) => call.source === "postgrest")).toBe(true);
    expect(calls.every((call) => call.durationMs >= 0)).toBe(true);
  });

  it("ignores a hook that throws", async () => {
    const sources = postgrestSources(client, {
      onSourceCall: () => {
        throw new Error("observer");
      },
    });
    await expect(sources.memberships.version?.({ id: "u1" })).resolves.toBe(3);
  });

  describe("repeated version reads", () => {
    it("warn once in development when one user's version is read twice in a request", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const sources = postgrestSources(client);
      await sources.memberships.version?.({ id: "u1" }, { memo: sourceMemo() });
      expect(warn).not.toHaveBeenCalled();
      await sources.memberships.version?.({ id: "u1" }, { memo: sourceMemo() });
      await sources.memberships.version?.({ id: "u1" }, { memo: sourceMemo() });
      expect(warn).toHaveBeenCalledOnce();
    });

    it("stay silent outside development and for a memo hit", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const quiet = postgrestSources(client);
      await quiet.memberships.version?.({ id: "u1" });
      await quiet.memberships.version?.({ id: "u1" });
      vi.stubEnv("NODE_ENV", "development");
      const shared = postgrestSources(client);
      const memo = sourceMemo();
      await shared.memberships.version?.({ id: "u1" }, { memo });
      await shared.memberships.version?.({ id: "u1" }, { memo });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
