import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/core/canonical-json.ts";

describe("canonicalJson", () => {
  it("sorts keys, drops undefined members and nulls undefined items", () => {
    expect(canonicalJson({ b: 1, a: [undefined, 2], c: undefined })).toBe(
      '{"a":[null,2],"b":1}',
    );
  });

  it("serialises bigints, dates and invalid dates", () => {
    expect(canonicalJson(5n)).toBe('"5n"');
    expect(canonicalJson(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(canonicalJson(new Date("invalid"))).toBe("null");
  });

  it("marks a repeated object on the current path as circular, not a shared sibling", () => {
    const shared = { id: 1 };
    const node: Record<string, unknown> = { shared, again: shared };
    node["self"] = node;
    expect(canonicalJson(node)).toBe(
      '{"again":{"id":1},"self":"[Circular]","shared":{"id":1}}',
    );
  });

  it("writes null for values JSON cannot express", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(() => 1)).toBe("null");
    expect(canonicalJson(Symbol("s"))).toBe("null");
  });
});

describe("RFC 8785 test vectors", () => {
  it("§3.2.2: serialises literals, numbers and strings", () => {
    const input = JSON.parse(
      String.raw`{
        "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
        "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
        "literals": [null, true, false]
      }`,
    );
    expect(canonicalJson(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it("§3.2.3: sorts property names by UTF-16 code units", () => {
    const input = JSON.parse(
      String.raw`{
        "\u20ac": "Euro Sign",
        "\r": "Carriage Return",
        "\ufb33": "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "\ud83d\ude00": "Emoji: Grinning Face",
        "\u0080": "Control",
        "\u00f6": "Latin Small Letter O With Diaeresis"
      }`,
    );
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00F6":"Latin Small Letter O With Diaeresis","\u20AC":"Euro Sign","\uD83D\uDE00":"Emoji: Grinning Face","\uFB33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it.each<[string, string]>([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ])("Appendix B: IEEE 754 %s serialises as %s", (bits, expected) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, BigInt(`0x${bits}`));
    expect(canonicalJson(view.getFloat64(0))).toBe(expected);
  });
});
