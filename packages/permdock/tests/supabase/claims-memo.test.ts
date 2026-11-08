import { describe, expect, it } from "vitest";

import { freezeDeep } from "../../src/core/freeze.ts";
import { instanceCache } from "../../src/index.ts";
import { supabaseClaims } from "../../src/supabase/index.ts";

const claims = {
  sub: "00000000-0000-4000-8000-000000000001",
  role: "authenticated",
  aud: "authenticated",
  memberships: [{ scope: "tenant", id: "t1", roles: ["member"] }],
};

describe("claims validation per object", () => {
  it("answers a frozen claims object the same each time", () => {
    const schema = supabaseClaims();
    const frozen = freezeDeep({ ...claims });
    const first = schema["~standard"].validate(frozen);
    expect(schema["~standard"].validate(frozen)).toStrictEqual(first);
  });

  it("re-checks an object that changed between calls", () => {
    const schema = supabaseClaims();
    const live: Record<string, unknown> = { ...claims };
    expect(schema["~standard"].validate(live)).not.toHaveProperty("issues");
    live["memberships"] = "not-an-array";
    expect(schema["~standard"].validate(live)).toHaveProperty("issues");
  });
});

describe("instance cache keys", () => {
  it("keys a frozen claims object once and a changed live object again", async () => {
    const cache = instanceCache();
    const frozen = freezeDeep({ ...claims });
    let builds = 0;
    const build = (): Promise<number> => {
      builds += 1;
      return Promise.resolve(builds);
    };
    const key = (user: unknown) => ({
      principal: "u1",
      version: 1,
      intent: "read" as const,
      parts: { user, data: {} },
    });
    await cache.instance(key(frozen), [], build);
    await cache.instance(key(frozen), [], build);
    expect(builds).toBe(1);
    const live: Record<string, unknown> = { ...claims };
    await cache.instance(key(live), [], build);
    live["memberships"] = [];
    await cache.instance(key(live), [], build);
    // the live object had the frozen one's content, so only the changed content builds again
    expect(builds).toBe(2);
  });
});
