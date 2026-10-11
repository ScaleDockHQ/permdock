import { describe, expect, it } from "vitest";

import {
  authorizationDetailsOf,
  delegationFrom,
} from "../../src/core/delegation-input.ts";
import { hasScope } from "../../src/core/oauth-scopes.ts";

const detail = { type: "payment", actions: ["create"] };

describe("delegationFrom", () => {
  it("reads authorization details under either name, camel case first", () => {
    expect(authorizationDetailsOf({ authorizationDetails: [detail] })).toEqual([
      detail,
    ]);
    expect(authorizationDetailsOf({ authorization_details: [detail] })).toEqual(
      [detail],
    );
    expect(
      authorizationDetailsOf({
        authorizationDetails: [],
        authorization_details: [detail],
      }),
    ).toEqual([]);
    expect(authorizationDetailsOf({ authorizationDetails: "x" })).toBe(
      undefined,
    );
    expect(authorizationDetailsOf(undefined)).toBe(undefined);
  });

  it("drops absent members", () => {
    expect(delegationFrom(["read"], undefined)).toEqual({ scopes: ["read"] });
    expect(
      delegationFrom(undefined, { authorization_details: [detail] }),
    ).toEqual({ authorizationDetails: [detail] });
  });
});

describe("hasScope", () => {
  it("is true when the token holds any wanted scope", () => {
    expect(hasScope(["a", "b"], ["c", "b"])).toBe(true);
    expect(hasScope(["a"], ["c"])).toBe(false);
    expect(hasScope(undefined, ["a"])).toBe(false);
    expect(hasScope(["a"], [])).toBe(false);
  });
});
