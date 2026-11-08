import { describe, expect, it } from "vitest";

import { pd113 } from "../../src/cli/doctor/supabase-jwt.ts";

describe("PD113 legacy HS256 verification", () => {
  it("flags the shared secret read from the environment", () => {
    const findings = pd113([
      {
        file: "src/auth.ts",
        text: "const key = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);",
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("PD113");
    expect(findings[0]?.target).toBe("src/auth.ts:1");
  });

  it("flags an HS256-only algorithm list and a Deno secret", () => {
    expect(
      pd113([
        { file: "a.ts", text: 'jwtVerify(t, k, { algorithms: ["HS256"] })' },
      ]),
    ).toHaveLength(1);
    expect(
      pd113([{ file: "b.ts", text: 'Deno.env.get("JWT_SECRET")' }]),
    ).toHaveLength(1);
  });

  it("passes ES256 and ignores comments", () => {
    expect(
      pd113([
        { file: "a.ts", text: 'jwtVerify(t, k, { algorithms: ["ES256"] })' },
        {
          file: "b.ts",
          text: "// process.env.JWT_SECRET is the legacy secret",
        },
      ]),
    ).toStrictEqual([]);
  });
});
