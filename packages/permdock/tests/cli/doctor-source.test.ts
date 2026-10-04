import { describe, expect, it } from "vitest";

import type {
  DoctorFinding,
  DoctorSource,
} from "../../src/cli/doctor-types.ts";

import {
  isClientSource,
  pd001,
  pd007,
  pd008,
  pd010,
  pd011,
  pd013,
  pd014,
  pd015,
  pd036,
  pd038,
  pd041,
  pd057,
} from "../../src/cli/doctor-source.ts";

function src(file: string, text: string): DoctorSource {
  return { file, text };
}

function messages(findings: readonly DoctorFinding[]): readonly string[] {
  return findings.map((item) => item.message);
}

describe("isClientSource", () => {
  it.each([
    [src("a.ts", "'use client'\n"), true],
    [src("a.ts", '"use client"\n'), true],
    [src("a.client.ts", ""), true],
    [src("entry.ts", ""), true],
    [src("server.ts", "'use server'\n"), false],
  ])("%o is client: %s", (source, expected) => {
    expect(isClientSource(source, new Set(["entry.ts"]))).toBe(expected);
  });
});

describe("PD001 server imports in client entries", () => {
  it("names each server specifier a client file imports, in either quote", () => {
    const findings = pd001([
      src(
        "a.client.ts",
        `import 'permdock/jwt'\nimport x from "permdock/mcp"\n`,
      ),
      src("server.ts", `import 'permdock/jwt'\n`),
      src("b.client.ts", `import 'permdock/react'\n`),
    ]);
    expect(messages(findings)).toEqual([
      "a.client.ts imports permdock/mcp",
      "a.client.ts imports permdock/jwt",
    ]);
  });
});

describe("PD007 validate never next to an adapter", () => {
  it("needs both the mode and an adapter import", () => {
    const never = src("policy.ts", `export const o = { validate: "never" }\n`);
    const adapter = src("app.ts", `import 'permdock/express'\n`);
    expect(pd007([never, adapter])).toHaveLength(1);
    expect(pd007([never])).toEqual([]);
    expect(pd007([adapter])).toEqual([]);
  });
});

describe("PD008 reserved export names", () => {
  it("flags dock, ability and $ members only in files that mention permdock", () => {
    expect(
      messages(
        pd008([
          src(
            "a.ts",
            `import 'permdock'\nexport function ability() {}\nexport type $Infer = 1\n`,
          ),
          src("b.ts", `export const dock = 1\n`),
          src("c.ts", `import 'permdock'\nexport const docker = 1\n`),
        ]),
      ),
    ).toEqual([
      "a.ts exports a reserved name (dock or ability)",
      "a.ts exports a $ prefixed member",
    ]);
  });
});

describe("PD010 untrusted claims", () => {
  it("flags each untrusted claim next to roles or tenant, outside comments", () => {
    expect(
      messages(
        pd010([
          src("a.ts", "export const r = claims.unsafeMetadata.roles;\n"),
          src(
            "b.ts",
            "export const t = claims.clientMetadata;\nexport const tenant = 1;\n",
          ),
          src("c.ts", "/* user_metadata.roles */\nexport const x = 1;\n"),
          src("d.ts", "export const name = claims.preferred_username;\n"),
        ]),
      ),
    ).toEqual([
      "a.ts reads roles or tenant from unsafeMetadata",
      "b.ts reads roles or tenant from clientMetadata",
    ]);
  });
});

describe("PD011 optional issuer tenant", () => {
  it("flags the hd claim and a Google issuer read as tenant", () => {
    expect(
      messages(
        pd011([
          src("a.ts", `export const o = { tenant: 'hd' }\n`),
          src("b.ts", `export const o = { "tenant": "hd" }\n`),
          src(
            "c.ts",
            `const issuer = 'https://accounts.google.com';\nexport const tenant = claims.org;\n`,
          ),
          src("d.ts", `const issuer = 'https://accounts.google.com';\n`),
          src("e.ts", `export const o = { tenant: 'org_id' }\n`),
        ]),
      ),
    ).toEqual([
      "a.ts reads tenant from an optional issuer claim",
      "b.ts reads tenant from an optional issuer claim",
      "c.ts reads tenant from an optional issuer claim",
    ]);
  });
});

describe("PD013 algorithms", () => {
  it("warns on EdDSA, errors on none, and accepts Ed25519", () => {
    const findings = pd013([
      src("a.ts", `algorithms: ['EdDSA']`),
      src("b.ts", `algorithms: ["none"]`),
      src("c.ts", `algorithms: ['Ed25519']`),
    ]);
    expect(findings.map((item) => [item.severity, item.message])).toEqual([
      ["warning", "a.ts lists polymorphic EdDSA"],
      ["error", "b.ts allows alg none"],
    ]);
  });
});

describe("PD014 discovery and jwks", () => {
  it.each([
    [`export const o = { discovery: 'https://issuer.example' }`, []],
    [
      `export const o = { discovery: 'https://i.example', jwks: { keys: [] } }`,
      ["a.ts sets discovery together with jwks or issuer"],
    ],
    [
      `export const o = { jwks: { keys: [] } }`,
      ["a.ts sets jwks without issuer"],
    ],
    [`export const o = { jwks: { keys: [] }, issuer: 'https://i' }`, []],
    [
      `export const o = { discovery: "http://i.example" }`,
      ["a.ts uses a plain-HTTP discovery URL"],
    ],
  ])("%s", (text, expected) => {
    expect(messages(pd014([src("a.ts", text)]))).toEqual(expected);
  });
});

describe("PD015 id tokens on an API resolver", () => {
  it("warns on accept id-token only", () => {
    expect(
      messages(
        pd015([
          src("a.ts", `accept: "id-token"`),
          src("b.ts", `accept: 'access-token'`),
        ]),
      ),
    ).toEqual(["a.ts accepts id-token on what looks like an API resolver"]);
  });
});

describe("PD038 tenant claim", () => {
  const run = (text: string): readonly string[] =>
    messages(pd038([src("s.ts", text)], "org_id", "tenant_id"));

  it("reads quoted tenant options, the fallback and skips what it cannot read", () => {
    expect(run(`subjectFromSupabase(claims)`)).toEqual([
      "s.ts:1 reads the tenant from 'tenant_id', but rls.tenantClaim is 'org_id'",
    ]);
    expect(run(`subjectFromSupabase(claims, { roles: 'r' })`)).toHaveLength(1);
    expect(run(`subjectFromSupabase(claims, { tenant: 'org_id' })`)).toEqual(
      [],
    );
    expect(run(`subjectFromSupabase(claims, { tenant: claim })`)).toEqual([]);
    expect(run(`subjectFromSupabase(claims, options)`)).toEqual([]);
    expect(run(`subjectFromSupabase(claims, { tenant: 'x'`)).toEqual([]);
    expect(
      run(`subjectFromSupabase(f('a\\'b', [1, 2]), { tenant: "team_id" })`),
    ).toEqual([
      "s.ts:1 reads the tenant from 'team_id', but rls.tenantClaim is 'org_id'",
    ]);
  });
});

describe("PD057 anonymous sign-ins", () => {
  const run = (text: string): readonly string[] =>
    messages(pd057([src("s.ts", text)]));

  it("warns on a subject call without anonymousSignIns: 'deny' and skips options it cannot read", () => {
    expect(run(`subjectFromSupabase(claims)`)).toEqual([
      "s.ts:1 maps anonymous sign-ins as users, but rls.anonymousSignIns is 'deny'",
    ]);
    expect(
      run(`subjectFromSupabaseSession(session, { tenant: 'org_id' })`),
    ).toHaveLength(1);
    expect(
      run(`subjectFromSupabaseSession(session, { anonymousSignIns: "deny" })`),
    ).toEqual([]);
    expect(
      run(
        `subjectFromSupabase(claims, { roles: 'r', anonymousSignIns: 'deny' })`,
      ),
    ).toEqual([]);
    expect(run(`subjectFromSupabase(claims, options)`)).toEqual([]);
    expect(run(`subjectFromSupabase(claims, { tenant: 'x'`)).toEqual([]);
  });
});

describe("PD041 HS256 capability tokens", () => {
  it("warns on HS256 only", () => {
    expect(
      messages(
        pd041([
          src(
            "l.ts",
            `exchangeCapability(s, { alg: "HS256" })\nexchangeCapability(s)\nexchangeCapability(s, { alg: 'ES256' })\n`,
          ),
        ]),
      ),
    ).toEqual([
      "l.ts:1 signs capability tokens with HS256, the project's shared JWT secret: whoever holds it can mint any user's token",
    ]);
  });
});

describe("PD036 BOLA", () => {
  it("skips files without permdock, loaders and routes without an id", () => {
    expect(
      pd036([src("a.ts", `app.get('/posts/:id', protect(p.read), h);\n`)]),
    ).toEqual([]);
    expect(
      pd036([
        src(
          "b.ts",
          `import 'permdock/hono';\napp.get('/posts', protect(p.list), h);\napp.get('/posts/:id', protect(p.read, load), h);\n`,
        ),
      ]),
    ).toEqual([]);
    expect(
      messages(
        pd036([
          src(
            "c.ts",
            `import 'permdock/hono';\napp.get(\`/orgs/{orgId}/posts\`, protect(p.list), h);\n`,
          ),
        ]),
      ),
    ).toEqual([
      "c.ts:2 protects /orgs/{orgId}/posts with p.list and no row loader, so the check never sees the row the id names (BOLA, OWASP API1)",
    ]);
  });
});
