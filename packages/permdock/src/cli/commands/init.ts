import type { EnumFlag } from "../core/command.ts";

import {
  PRESET_DEFAULTS,
  PRESET_FLAGS,
  type Preset,
  type PresetInput,
} from "../../preset/index.ts";
import { type Leaf, defineLeaf } from "../core/command.ts";
import { dryRunFlag, forceFlag, given } from "../core/flags.ts";

function optionsOf(key: keyof Preset): string[] {
  return PRESET_FLAGS[key].choices
    .filter((item) => item.retired !== true)
    .map((item) => item.id);
}

function one(
  key: "archetype" | "auth" | "backend" | "framework",
  description: string,
): EnumFlag & { readonly default: string } {
  return {
    type: "enum",
    options: optionsOf(key),
    description: `Without --preset: ${description}`,
    default: PRESET_DEFAULTS[key],
  };
}

function many(
  key: "features" | "integrations" | "services",
  description: string,
): EnumFlag & { readonly repeatable: true } {
  return {
    type: "enum",
    options: optionsOf(key),
    description: `Without --preset: ${description}`,
    repeatable: true,
    valueHint: "id",
  };
}

export const init: Leaf = defineLeaf({
  flags: {
    preset: {
      type: "string",
      description: "A preset code from permdock.com/create",
      valueHint: "code",
    },
    archetype: { ...one("archetype", "the kind of app"), valueHint: "id" },
    framework: one("framework", "where requests arrive"),
    auth: one("auth", "who signs users in"),
    backend: one("backend", "where data lives"),
    feature: many("features", "a feature beyond the archetype's"),
    integration: many(
      "integrations",
      "an agent runtime or a set of UI recipes",
    ),
    service: many("services", "a PermDock Cloud service"),
    "out-dir": {
      type: "string",
      description: "Source directory the files go in (default src)",
      valueHint: "dir",
    },
    ...dryRunFlag,
    ...forceFlag,
  },
  async run(ctx, { flags }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const [{ runInit }, { packageManagerOf }] = await Promise.all([
      import("../init.ts"),
      import("../core/peer.ts"),
    ]);
    const agent = await packageManagerOf(ctx.cwd);
    // SAFETY: every selection flag is an enum over its catalogue, so the parser already refused any other id.
    const selection = {
      archetype: flags.archetype,
      framework: flags.framework,
      auth: flags.auth,
      backend: flags.backend,
      features: flags.feature,
      integrations: flags.integration,
      services: flags.service,
    } as PresetInput;
    const outDir = given(flags["out-dir"]);
    return runInit({
      cwd: ctx.cwd,
      preset: given(flags.preset) ?? selection,
      ...(outDir === undefined ? {} : { src: outDir }),
      dryRun: flags["dry-run"],
      force: flags.force,
      ...(agent === undefined ? {} : { agent }),
    });
  },
});

const presetCode = [
  { name: "code", description: "The preset code", required: true },
] as const;

export const presetDecode: Leaf = defineLeaf({
  positionals: presetCode,
  flags: {},
  async run(_ctx, { args }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runPreset } = await import("../init.ts");
    return runPreset("decode", args["code"] ?? "");
  },
});

export const presetUrl: Leaf = defineLeaf({
  positionals: presetCode,
  flags: {},
  async run(_ctx, { args }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runPreset } = await import("../init.ts");
    return runPreset("url", args["code"] ?? "");
  },
});
