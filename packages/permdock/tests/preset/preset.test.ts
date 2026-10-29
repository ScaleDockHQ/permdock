import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { Preset, PresetInput } from "../../src/preset/index.ts";

import { getPermDockSync } from "../../src/index.ts";
import { DOMAINS } from "../../src/preset/domain.ts";
import {
  ARCHETYPES,
  decodePreset,
  encodePreset,
  generatePreset,
  presetMatrix,
  resolvePreset,
} from "../../src/preset/index.ts";

const PACKAGE = fileURLToPath(new URL("../..", import.meta.url));
const OUT = path.join(PACKAGE, ".preset-check");

const CASES: readonly PresetInput[] = [
  ...ARCHETYPES.map((archetype) => ({ archetype: archetype.id })),
  { archetype: "b2b", framework: "hono", features: ["approvals", "rls"] },
  {
    archetype: "b2b",
    framework: "express",
    auth: "supabase",
    backend: "supabase",
    features: ["rls", "plans", "limits"],
  },
  {
    archetype: "b2b",
    framework: "next",
    auth: "supabase",
    backend: "prisma",
    integrations: ["ai-sdk"],
  },
  {
    archetype: "agent",
    framework: "none",
    auth: "jwt",
    integrations: ["ai-sdk", "mcp"],
    services: ["cloud-decision-log", "cloud-approvals"],
  },
  {
    archetype: "agent",
    framework: "hono",
    auth: "jwt",
    integrations: ["ai-sdk"],
  },
  {
    archetype: "api",
    framework: "next",
    auth: "clerk",
    services: ["cloud-hosted-grants", "cloud-snapshots"],
    integrations: ["shadcn", "react-native"],
  },
  {
    archetype: "marketplace",
    framework: "hono",
    auth: "better-auth",
    backend: "drizzle",
    features: ["tenancy", "custom-roles", "decision-log", "rls"],
  },
  {
    archetype: "consumer",
    framework: "express",
    auth: "clerk",
    backend: "prisma",
    integrations: ["ai-sdk"],
  },
  {
    archetype: "b2b",
    framework: "none",
    auth: "better-auth",
    backend: "drizzle",
  },
];

/** Type-only stand-ins for the provider packages that are not dev dependencies. */
const STUBS: Readonly<Record<string, string>> = {
  "better-auth": `export declare function betterAuth(options: unknown): {
  readonly $context: Promise<Record<never, never>>;
  readonly api: {
    getSession(args: { readonly headers: Headers }): Promise<unknown>;
    listOrganizations(args?: { readonly headers?: unknown }): Promise<unknown>;
  };
};`,
  "better-auth/plugins": "export declare function organization(): unknown;",
  "@clerk/nextjs/server": "export declare function auth(): Promise<unknown>;",
  "@clerk/backend": `export declare function createClerkClient(options: {
  readonly secretKey: string;
  readonly publishableKey: string;
}): { authenticateRequest(request: Request): Promise<{ toAuth(): unknown }> };`,
  "@supabase/ssr": `type Cookie = { readonly name: string; readonly value: string; readonly options: { readonly path?: string; readonly maxAge?: number; readonly httpOnly?: boolean } };
export declare function createServerClient(
  url: string,
  key: string,
  options: {
    readonly cookies: {
      readonly getAll: () => readonly { readonly name: string; readonly value: string }[];
      readonly setAll: (cookies: readonly Cookie[], headers: Record<string, string>) => void;
    };
  },
): {
  readonly auth: {
    getClaims(): Promise<
      | { readonly data: { readonly claims: { readonly sub: string } }; readonly error: null }
      | { readonly data: null; readonly error: Error }
    >;
  };
};`,
  "@prisma/adapter-pg": `export declare class PrismaPg {
  constructor(options: { readonly connectionString: string });
}`,
  "prisma/config": `export declare function defineConfig(config: unknown): unknown;
export declare function env(name: string): string;`,
};

/** What `prisma generate` would write to src/generated/client.ts for `preset`. */
function prismaClientStub(preset: Preset): string {
  const types = DOMAINS[preset.archetype].resources.map((resource) => {
    const type = resource.name.charAt(0).toUpperCase() + resource.name.slice(1);
    return { name: resource.name, type };
  });
  return `import type { ${types.map(({ type }) => type).join(", ")} } from "../permissions";

type Delegate<T> = {
  findUnique(args: { readonly where: { readonly id: string } }): Promise<T | null>;
  findMany(args: { readonly where: unknown }): Promise<T[]>;
};

export declare namespace Prisma {
${types.map(({ type }) => `  type ${type}WhereInput = Record<string, unknown>;`).join("\n")}
}

export declare class PrismaClient {
  constructor(options: { readonly adapter: unknown });
${types.map(({ name: model, type }) => `  readonly ${model}: Delegate<${type}>;`).join("\n")}
}
`;
}

function name(preset: Preset): string {
  return encodePreset(preset).replaceAll(/[^\w]/gu, "_");
}

/**
 * Writes each case under .preset-check/<code>, with permdock imports pointed at
 * src.
 */
function writeCases(): readonly string[] {
  rmSync(OUT, { recursive: true, force: true });
  const dirs: string[] = [];
  for (const input of CASES) {
    const preset = resolvePreset(input);
    const dir = path.join(OUT, name(preset));
    for (const file of generatePreset(preset).files) {
      const target = path.join(dir, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }
    if (preset.backend === "prisma") {
      const client = path.join(dir, "src", "generated", "client.ts");
      mkdirSync(path.dirname(client), { recursive: true });
      writeFileSync(client, prismaClientStub(preset));
    }
    dirs.push(dir);
  }
  const stubPaths: Record<string, string[]> = {};
  for (const [specifier, contents] of Object.entries(STUBS)) {
    const file = path.join(
      "stubs",
      `${specifier.replaceAll(/[^\w]/gu, "_")}.ts`,
    );
    mkdirSync(path.join(OUT, "stubs"), { recursive: true });
    writeFileSync(path.join(OUT, file), contents);
    stubPaths[specifier] = [`./${file}`];
  }
  writeFileSync(
    path.join(OUT, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "esnext",
          lib: ["esnext"],
          module: "esnext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          types: ["node"],
          jsx: "react-jsx",
          paths: {
            permdock: ["../src/index.ts"],
            "permdock/*": ["../src/*/index.ts"],
            ...stubPaths,
          },
        },
        include: ["./**/*.ts"],
      },
      null,
      2,
    ),
  );
  return dirs;
}

describe("preset codes", () => {
  it("round-trips every case and keeps resolution idempotent", () => {
    for (const input of CASES) {
      const preset = resolvePreset(input);
      const code = encodePreset(preset);
      expect(code.startsWith("p1")).toBe(true);
      expect(decodePreset(code)).toStrictEqual(preset);
      expect(resolvePreset(preset)).toStrictEqual(preset);
    }
  });

  it("refuses a code of another version or with foreign characters", () => {
    expect(decodePreset("p2AAAA")).toBeUndefined();
    expect(decodePreset("p1A!")).toBeUndefined();
    expect(decodePreset("p1A")).toBeUndefined();
  });

  it("decodes codes written before the integrations rename to the same choices", () => {
    expect(decodePreset("p1AQAAAxwAAwAD")).toStrictEqual(
      resolvePreset({
        archetype: "agent",
        framework: "none",
        integrations: ["ai-sdk", "mcp"],
        services: ["cloud-decision-log", "cloud-approvals"],
      }),
    );
  });

  it("turns on what an archetype, an agent runtime and a feature require", () => {
    const preset = resolvePreset({
      archetype: "consumer",
      integrations: ["mcp"],
      features: ["custom-roles"],
    });
    expect(preset.features).toStrictEqual([
      "tenancy",
      "custom-roles",
      "operations",
      "limits",
      "plans",
      "ownership",
    ]);
  });
});

describe("generated presets", () => {
  it("refresh a Next.js Supabase session in proxy.ts with the setAll cache headers", () => {
    const files = generatePreset(
      resolvePreset({ archetype: "b2b", framework: "next", auth: "supabase" }),
    ).files;
    const proxy = files.find((file) => file.path === "src/proxy.ts");
    expect(proxy?.contents).toContain("await supabase.auth.getClaims();");
    expect(proxy?.contents).toContain("response.headers.set(key, value)");
    const session = files.find((file) => file.path === "src/session.ts");
    expect(session?.contents).toContain("createServerClient");
    expect(session?.contents).not.toContain("getSession");
    const hono = generatePreset(
      resolvePreset({ archetype: "b2b", framework: "hono", auth: "supabase" }),
    ).files;
    expect(hono.some((file) => file.path.endsWith("proxy.ts"))).toBe(false);
  });

  it("type-check against the package source", () => {
    writeCases();
    const tsc = path.join(PACKAGE, "node_modules", ".bin", "tsc");
    expect(() =>
      execFileSync(tsc, ["-p", path.join(OUT, "tsconfig.json")], {
        cwd: PACKAGE,
        stdio: "pipe",
      }),
    ).not.toThrow();
  }, 120_000);

  it("produce a policy whose demo user is granted and an app that starts", async () => {
    vi.stubEnv("PERMDOCK_CLOUD_URL", "https://cloud.example.com");
    vi.stubEnv("PERMDOCK_CLOUD_KEY", "pdk_test_key");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    for (const input of CASES) {
      const preset = resolvePreset(input);
      const dir = path.join(OUT, name(preset), "src");
      const policyModule: {
        readonly policy: Parameters<typeof getPermDockSync>[0];
        readonly demoUser: unknown;
      } = await import(path.join(dir, "policy.ts"));
      const permdock = getPermDockSync(
        policyModule.policy,
        policyModule.demoUser,
      );
      expect(permdock.subject.principal?.id).toBe("u1");
      const first = DOMAINS[preset.archetype].resources[0]?.name ?? "";
      // SAFETY: a permission tree maps each resource name to its permission leaves.
      const tree = permdock.permissions as Record<
        string,
        Record<string, Parameters<typeof permdock.can>[0]>
      >;
      const list = tree[first]?.["list"];
      expect(list).toBeDefined();
      if (list !== undefined) {
        expect({
          preset: preset.archetype,
          can: permdock.can(list, undefined),
        }).toStrictEqual({ preset: preset.archetype, can: true });
      }
      const appModule: { readonly app: unknown } = await import(
        path.join(dir, "permdock.ts")
      );
      expect(appModule.app).toBeDefined();
    }
    vi.unstubAllEnvs();
  }, 120_000);
});

describe(presetMatrix, () => {
  it("agrees with the generated policy on the demo user's collection actions", async () => {
    writeCases();
    vi.stubEnv("PERMDOCK_CLOUD_URL", "https://cloud.example.com");
    vi.stubEnv("PERMDOCK_CLOUD_KEY", "pdk_test_key");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test");
    // Supabase memberships come from PostgREST, so those apps cannot decide offline.
    for (const input of CASES.filter((item) => item.backend !== "supabase")) {
      const preset = resolvePreset(input);
      const domain = DOMAINS[preset.archetype];
      const dir = path.join(OUT, name(preset), "src");
      const policyModule: {
        readonly policy: Parameters<typeof getPermDockSync>[0];
        readonly demoUser: unknown;
      } = await import(path.join(dir, "policy.ts"));
      // The generated app: profile dev, so limits have a memory store.
      const appModule: { readonly app: Parameters<typeof getPermDockSync>[0] } =
        await import(path.join(dir, "permdock.ts"));
      const permdock = getPermDockSync(appModule.app, policyModule.demoUser);
      // SAFETY: a permission tree maps each resource name to its permission leaves.
      const tree = permdock.permissions as Record<
        string,
        Record<string, Parameters<typeof permdock.decide>[0]>
      >;
      const collection = new Set(["create", "list"]);
      for (const row of presetMatrix(preset).rows) {
        const spec = domain.resources.find(
          (item) => item.name === row.resource,
        );
        if (
          !collection.has(row.action) &&
          !(spec?.collection ?? []).includes(row.action)
        ) {
          continue;
        }
        const cell = row.cells[domain.demoRole];
        const leaf = tree[row.resource]?.[row.action];
        if (cell === undefined || leaf === undefined) {
          continue;
        }
        const outcome = permdock.decide(leaf, undefined).outcome;
        const expected =
          cell.access === "allow"
            ? cell.approval
              ? "approval-required"
              : "granted"
            : "denied";
        expect({
          preset: preset.archetype,
          key: leaf.key,
          outcome,
        }).toStrictEqual({
          preset: preset.archetype,
          key: leaf.key,
          outcome: expected,
        });
      }
    }
    vi.unstubAllEnvs();
  }, 120_000);
});
