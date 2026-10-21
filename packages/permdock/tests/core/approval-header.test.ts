import { describe, expect, it } from "vitest";

import { readApprovalHeader } from "../../src/approvals/index.ts";
import { approvalHeaders } from "../../src/client/headers.ts";
import {
  approvalHeaderValue,
  parseApprovalHeader,
} from "../../src/core/approval-header.ts";

const TOKEN = "sha-256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

describe("PermDock-Approval field", () => {
  it.each<[string, string | undefined]>([
    [TOKEN, TOKEN],
    [`  ${TOKEN} `, TOKEN],
    ["pd1.abc", "pd1.abc"],
    ["*star/a:b", "*star/a:b"],
    ["", undefined],
    ["   ", undefined],
    [`"${TOKEN}"`, undefined],
    [`${TOKEN};a=1`, undefined],
    [`${TOKEN}, ${TOKEN}`, undefined],
    ["1abc", undefined],
    ["a b", undefined],
    [":abc", undefined],
    ["abc=", undefined],
  ])("parses %j as %j", (value, token) => {
    expect(parseApprovalHeader(value)).toBe(token);
    expect(
      readApprovalHeader(new Headers({ "PermDock-Approval": value })),
    ).toBe(token);
  });

  it("reads no token from an absent field", () => {
    expect(parseApprovalHeader(null)).toBeUndefined();
    expect(parseApprovalHeader(`\t${TOKEN}`)).toBeUndefined();
    expect(readApprovalHeader(new Headers())).toBeUndefined();
  });

  it("serialises only an sf-token", () => {
    expect(approvalHeaderValue(TOKEN)).toBe(TOKEN);
    expect(approvalHeaders(TOKEN)).toStrictEqual({
      "PermDock-Approval": TOKEN,
    });
    expect(() => approvalHeaders(`"${TOKEN}"`)).toThrow(TypeError);
    expect(() => approvalHeaderValue(" a")).toThrow(TypeError);
    expect(() => approvalHeaderValue("")).toThrow(TypeError);
  });
});
