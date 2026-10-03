import { describe, expect, it } from "vitest";

import { parseGrantsMarker, parseHookMarker } from "../../src/cli/index.ts";

describe("parseHookMarker", () => {
  it("reads the fields of the hook marker line", () => {
    const sql =
      "-- permdock:hook v1 schema=public tenant=tenant_id budget=2048 claims=user_role,roles,memberships\n-- rest";
    expect(parseHookMarker(sql)).toEqual({
      version: 1,
      schema: "public",
      tenantClaim: "tenant_id",
      budget: 2048,
      claims: ["user_role", "roles", "memberships"],
    });
  });

  it("accepts CRLF and a bare marker, and refuses other first lines", () => {
    expect(parseHookMarker("-- permdock:hook v1\r\nselect 1;")).toEqual({
      version: 1,
      claims: [],
    });
    expect(parseHookMarker("-- permdock:hook v2 schema=auth")).toMatchObject({
      version: 2,
      schema: "auth",
    });
    expect(parseHookMarker("select 1;\n-- permdock:hook v1")).toBeUndefined();
    expect(parseHookMarker("-- permdock:hook v0")).toBeUndefined();
    expect(parseHookMarker("-- permdock:hooks v1")).toBeUndefined();
    expect(parseHookMarker("-- permdock:grants v1")).toBeUndefined();
  });

  it("drops a budget that is not a positive integer", () => {
    expect(
      parseHookMarker("-- permdock:hook v1 budget=abc")?.budget,
    ).toBeUndefined();
  });

  it("never assigns onto Object.prototype", () => {
    parseHookMarker("-- permdock:hook v1 __proto__=x constructor=y");
    expect(Reflect.get({}, "x")).toBeUndefined();
  });
});

describe("parseGrantsMarker", () => {
  it("reads the schema of a grants migration", () => {
    expect(
      parseGrantsMarker("-- permdock:grants v1 schema=public\ngrant usage;"),
    ).toEqual({ version: 1, schema: "public" });
    expect(parseGrantsMarker("-- permdock:grants v1")).toEqual({ version: 1 });
    expect(
      parseGrantsMarker("-- permdock:hook v1 schema=public"),
    ).toBeUndefined();
    expect(parseGrantsMarker("")).toBeUndefined();
  });
});
