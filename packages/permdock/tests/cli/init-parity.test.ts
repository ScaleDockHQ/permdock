import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Preset } from "../../src/preset/index.ts";

import { init } from "../../src/cli/commands/init.ts";
import { run } from "../../src/cli/core/run.ts";
import {
  PRESET_DEFAULTS,
  PRESET_FLAGS,
  encodePreset,
  presetFlags,
  resolvePreset,
} from "../../src/preset/index.ts";
import { jsonData } from "./envelope.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// SAFETY: PRESET_FLAGS is typed with exactly the keys of Preset.
const KEYS = Object.keys(PRESET_FLAGS) as (keyof Preset)[];

describe("permdock init and the preset catalogue", () => {
  it("has one flag per preset key, offering the catalogue's ids", () => {
    for (const key of KEYS) {
      const { flag, choices, repeatable } = PRESET_FLAGS[key];
      const spec = init.flags[flag];
      expect({ key, type: spec?.type }).toEqual({ key, type: "enum" });
      if (spec?.type !== "enum") {
        continue;
      }
      expect({ key, options: spec.options }).toEqual({
        key,
        options: choices
          .filter((choice) => choice.retired !== true)
          .map((choice) => choice.id),
      });
      expect({ key, repeatable: spec.repeatable === true }).toEqual({
        key,
        repeatable,
      });
    }
  });

  it("defaults each single-choice flag to the builder's default", () => {
    for (const key of ["archetype", "auth", "backend", "framework"] as const) {
      const spec = init.flags[PRESET_FLAGS[key].flag];
      expect({
        key,
        default: spec?.type === "enum" ? spec.default : undefined,
      }).toEqual({
        key,
        default: PRESET_DEFAULTS[key],
      });
    }
  });

  it("selects the same preset from the flags preset decode prints", async () => {
    const presets: readonly Preset[] = [
      resolvePreset({ archetype: "b2b" }),
      resolvePreset({
        archetype: "marketplace",
        framework: "hono",
        auth: "better-auth",
        backend: "drizzle",
        features: ["custom-roles", "rls"],
        integrations: ["mcp", "shadcn"],
        services: ["cloud-decision-log", "cloud-snapshots"],
      }),
      resolvePreset({
        archetype: "api",
        framework: "none",
        auth: "jwt",
        backend: "prisma",
        integrations: ["react-native"],
      }),
    ];
    for (const preset of presets) {
      const cwd = mkdtempSync(join(tmpdir(), "permdock-parity-"));
      dirs.push(cwd);
      const result = await run(
        ["init", ...presetFlags(preset), "--dry-run", "--json"],
        { cwd },
      );
      const report: { readonly preset: string } = jsonData(result.stdout);
      expect(report.preset).toBe(encodePreset(preset));
    }
  });
});
