import type { Choice, Preset } from "./catalog.ts";

import {
  ARCHETYPES,
  AUTH,
  BACKENDS,
  FEATURES,
  FRAMEWORKS,
  INTEGRATIONS,
  PRESET_DEFAULTS,
  SERVICES,
  resolvePreset,
} from "./catalog.ts";

/** One `permdock init` flag per preset key, with the catalogue it takes values from. */
export const PRESET_FLAGS: {
  readonly [K in keyof Preset]: {
    readonly flag: string;
    readonly choices: readonly Choice<string>[];
    readonly repeatable: boolean;
  };
} = {
  archetype: { flag: "archetype", choices: ARCHETYPES, repeatable: false },
  features: { flag: "feature", choices: FEATURES, repeatable: true },
  auth: { flag: "auth", choices: AUTH, repeatable: false },
  backend: { flag: "backend", choices: BACKENDS, repeatable: false },
  framework: { flag: "framework", choices: FRAMEWORKS, repeatable: false },
  integrations: {
    flag: "integration",
    choices: INTEGRATIONS,
    repeatable: true,
  },
  services: { flag: "service", choices: SERVICES, repeatable: true },
};

/**
 * The `permdock init` flags that select `preset`, leaving out defaults and
 * the features its archetype and integrations already turn on, so
 * `permdock init <flags>` resolves to the same preset.
 */
export function presetFlags(preset: Preset): string[] {
  const implied = resolvePreset({
    archetype: preset.archetype,
    integrations: preset.integrations,
  }).features;
  const args: string[] = [];
  const single = (
    key: "archetype" | "auth" | "backend" | "framework",
  ): void => {
    if (key === "archetype" || preset[key] !== PRESET_DEFAULTS[key]) {
      args.push(`--${PRESET_FLAGS[key].flag}`, preset[key]);
    }
  };
  const many = (key: "features" | "integrations" | "services"): void => {
    const values: readonly string[] =
      key === "features"
        ? preset.features.filter((feature) => !implied.includes(feature))
        : preset[key];
    for (const value of values) {
      args.push(`--${PRESET_FLAGS[key].flag}`, value);
    }
  };
  single("archetype");
  single("framework");
  single("auth");
  single("backend");
  many("features");
  many("integrations");
  many("services");
  return args;
}
