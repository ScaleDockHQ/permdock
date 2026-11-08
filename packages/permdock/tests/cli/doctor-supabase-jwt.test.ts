import { describe, expect, it } from "vitest";

import { pd114 } from "../../src/cli/doctor/perf-token.ts";
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

describe("PD114 truncated tokens in jwt mode", () => {
  it("warns on jwt mode with a hook", () => {
    expect(
      pd114({ rls: { authorize: "jwt" }, supabase: { hook: {} } }).map(
        (finding) => finding.code,
      ),
    ).toStrictEqual(["PD114"]);
  });

  it("passes database mode and a project with no hook", () => {
    expect(
      pd114({ rls: { authorize: "database" }, supabase: { hook: {} } }),
    ).toStrictEqual([]);
    expect(pd114({ rls: { authorize: "jwt" } })).toStrictEqual([]);
  });
});
