import { describe, expect, it } from "vitest";

import { postgrestSources } from "../../src/supabase/index.ts";
import { postgrestFixture } from "../../src/testing/fixtures/index.ts";

const subjects = {
  u1: {
    id: "u1",
    active: true,
    roles: ["staff"],
    memberships: [{ scope: "org", id: "o1", roles: ["owner"] }],
    customRoles: [],
    authzVersion: 4,
  },
};

describe(postgrestFixture, () => {
  it("answers subject_for and authz_version_for through postgrestSources", async () => {
    const fixture = postgrestFixture({ subjects });
    const sources = postgrestSources(fixture);
    expect((await sources.record("u1"))?.roles).toStrictEqual(["staff"]);
    expect(await sources.record("nobody")).toBeUndefined();
    expect(await sources.memberships.version?.({ id: "u1" }, {})).toBe(4);
    expect(fixture.calls.map((call) => call.fn)).toStrictEqual([
      "subject_for",
      "subject_for",
      "authz_version_for",
    ]);
  });

  it("answers a version override and the members of one scope instance", async () => {
    const entry = {
      principal: { id: "u1" },
      membership: { scope: "org", id: "o1", roles: ["owner"] },
    };
    const sources = postgrestSources(
      postgrestFixture({ subjects, versions: { u1: 9 }, members: [entry] }),
    );
    expect(await sources.memberships.version?.({ id: "u1" }, {})).toBe(9);
    expect(
      await sources.memberships.list({ scope: "org", id: "o1" }),
    ).toStrictEqual([entry]);
    expect(
      await sources.memberships.list({ scope: "org", id: "o2" }),
    ).toStrictEqual([]);
  });

  it("answers a wrapper prefix as the function it wraps", async () => {
    const sources = postgrestSources(postgrestFixture({ subjects }), {
      api: {},
    });
    expect((await sources.record("u1"))?.id).toBe("u1");
  });
});
