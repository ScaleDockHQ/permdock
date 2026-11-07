import { describe, expect, it } from "vitest";

import { joinOn, throughRows } from "../../src/cli/powersync/sources.ts";
import { POSTGRES } from "../../src/cli/powersync/stream-types.ts";

const own = { table: "m", from: "public.m m", where: ["true"] };

describe("through rows", () => {
  it("keeps the signed-in user on one pair and filters the other pairs", () => {
    const one = throughRows(
      { through: "members", on: { user_id: "user_id" }, column: "role" },
      own,
      POSTGRES,
      "user_id",
    );
    expect(one.user).toBe("user_id");
    expect(one.query).toContain("= $1::text");
    expect(one.query).toContain("IN (SELECT");
    const two = throughRows(
      {
        through: "members",
        on: { org_id: "org_id", user_id: "user_id" },
        column: "role",
      },
      own,
      POSTGRES,
      "user_id",
    );
    expect(two.query).toContain("org_id");
    expect(two.query).toContain("= $1::text");
  });

  it("refuses a reference that names no column", () => {
    expect(() =>
      joinOn(
        { through: "members", on: {}, column: "role" },
        "id",
        "m",
        POSTGRES,
      ),
    ).toThrow("names no column");
  });
});
