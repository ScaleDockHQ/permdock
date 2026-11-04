import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import { sourceMemo } from "../../src/core/source-memo.ts";
import { memorySubjectCache } from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";

function database(version: () => number): {
  readonly client: SupabaseRpcClient;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    client: {
      schema: () => ({
        async rpc(fn, args) {
          calls.push(fn);
          if (fn === "authz_version_for") {
            return { data: version(), error: null };
          }
          return {
            data: {
              id: args["p_user"],
              active: true,
              roles: ["staff"],
              memberships: [],
              customRoles: [],
              authzVersion: version(),
            },
            error: null,
          };
        },
      }),
    },
  };
}

const reads = (calls: readonly string[]): number =>
  calls.filter((name) => name === "subject_for").length;

describe("postgrestSources subjects", () => {
  it("reads subject_for again for every instance without a cache", async () => {
    const { client, calls } = database(() => 1);
    const sources = postgrestSources(client);
    await sources.record("u1");
    await sources.record("u1");
    expect(reads(calls)).toBe(2);
  });

  it("reads the cache before subject_for at the version the instance resolved", async () => {
    const { client, calls } = database(() => 3);
    const sources = postgrestSources(client, {
      subjects: memorySubjectCache(),
    });
    const first = sourceMemo();
    await sources.memberships.version?.({ id: "u1" }, { memo: first });
    await sources.memberships.membershipsFor({ id: "u1" }, { memo: first });
    const second = sourceMemo();
    await sources.memberships.version?.({ id: "u1" }, { memo: second });
    const found = await sources.memberships.membershipsFor(
      { id: "u1" },
      { memo: second },
    );
    expect(found).toStrictEqual([]);
    expect(reads(calls)).toBe(1);
    expect(calls.filter((name) => name === "authz_version_for")).toHaveLength(
      2,
    );
  });

  it("reads again once the version moved", async () => {
    let version = 1;
    const { client, calls } = database(() => version);
    const sources = postgrestSources(client, {
      subjects: memorySubjectCache(),
    });
    const read = async (): Promise<void> => {
      const memo = sourceMemo();
      await sources.memberships.version?.({ id: "u1" }, { memo });
      await sources.memberships.membershipsFor({ id: "u1" }, { memo });
    };
    await read();
    version = 2;
    await read();
    expect(reads(calls)).toBe(2);
  });

  it("never answers a record the cache holds at another version", async () => {
    let version = 5;
    const { client, calls } = database(() => version);
    const subjects = memorySubjectCache();
    const sources = postgrestSources(client, { subjects });
    const memo = sourceMemo();
    await sources.memberships.version?.({ id: "u1" }, { memo });
    await sources.memberships.membershipsFor({ id: "u1" }, { memo });
    version = 6;
    const next = sourceMemo();
    await sources.memberships.version?.({ id: "u1" }, { memo: next });
    await sources.memberships.membershipsFor({ id: "u1" }, { memo: next });
    expect(reads(calls)).toBe(2);
  });
});
