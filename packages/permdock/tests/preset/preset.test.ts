import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { Preset, PresetInput } from "../../src/preset/index.ts";

import { createPermDock } from "../../src/index.ts";
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
    backend: "supabase",
    features: ["rls", "plans", "limits"],
  },
  {
    archetype: "agent",
    framework: "none",
    agents: ["ai-sdk", "mcp"],
    services: ["cloud-decision-log", "cloud-approvals"],
  },
  {
    archetype: "api",
    framework: "next",
    services: ["cloud-hosted-grants"],
    ui: ["shadcn", "react-native"],
  },
  {
    archetype: "marketplace",
    framework: "hono",
    features: ["tenancy", "custom-roles", "audit", "rls"],
  },
  { archetype: "consumer", framework: "express", agents: ["ai-sdk"] },
];

function name(preset: Preset): string {
  return encodePreset(preset).replaceAll(/[^\w]/gu, "_");
}

/** Writes each case under .preset-check/<code>, with permdock imports pointed at src. */
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
    dirs.push(dir);
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
      expect(decodePreset(code)).toEqual(preset);
      expect(resolvePreset(preset)).toEqual(preset);
    }
  });

  it("refuses a code of another version or with foreign characters", () => {
    expect(decodePreset("p2AAAA")).toBeUndefined();
    expect(decodePreset("p1A!")).toBeUndefined();
    expect(decodePreset("p1A")).toBeUndefined();
  });

  it("turns on what an archetype, an agent runtime and a feature require", () => {
    const preset = resolvePreset({
      archetype: "consumer",
      agents: ["mcp"],
      features: ["custom-roles"],
    });
    expect(preset.features).toEqual([
      "tenancy",
      "custom-roles",
      "agents",
      "limits",
      "plans",
      "ownership",
    ]);
  });
});

describe("generated presets", () => {
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
    for (const input of CASES) {
      const preset = resolvePreset(input);
      const dir = path.join(OUT, name(preset), "src");
      const policyModule: {
        readonly policy: Parameters<typeof createPermDock>[0];
        readonly demoUser: unknown;
      } = await import(path.join(dir, "policy.ts"));
      const permdock = createPermDock(
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
        }).toEqual({
          preset: preset.archetype,
          can: true,
        });
      }
      const appModule: { readonly app: unknown } = await import(
        path.join(dir, "permdock.ts")
      );
      expect(appModule.app).toBeDefined();
    }
    vi.unstubAllEnvs();
  }, 120_000);
});

describe("presetMatrix", () => {
  it("agrees with the generated policy on the demo user's collection actions", async () => {
    writeCases();
    for (const input of CASES) {
      const preset = resolvePreset(input);
      const domain = DOMAINS[preset.archetype];
      const dir = path.join(OUT, name(preset), "src");
      const policyModule: {
        readonly policy: Parameters<typeof createPermDock>[0];
        readonly demoUser: unknown;
      } = await import(path.join(dir, "policy.ts"));
      // The generated app: profile dev, so limits have a memory store.
      const appModule: {
        readonly app: Parameters<typeof createPermDock>[0];
      } = await import(path.join(dir, "permdock.ts"));
      const permdock = createPermDock(appModule.app, policyModule.demoUser);
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
        expect({ preset: preset.archetype, key: leaf.key, outcome }).toEqual({
          preset: preset.archetype,
          key: leaf.key,
          outcome: expected,
        });
      }
    }
  }, 120_000);
});
