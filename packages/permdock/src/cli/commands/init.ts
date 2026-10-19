import type { PresetInput } from "../../preset/index.ts";

import { AGENTS, UI } from "../../preset/index.ts";
import { suggestion } from "../core/args.ts";
import { type Leaf, defineLeaf } from "../core/command.ts";
import { CliError } from "../core/errors.ts";
import { dryRunFlag, forceFlag, given } from "../core/flags.ts";

const AGENT_IDS: readonly string[] = AGENTS.map((choice) => choice.id);
const UI_IDS: readonly string[] = UI.map((choice) => choice.id);

export const init: Leaf = defineLeaf({
  flags: {
    preset: {
      type: "string",
      description: "A preset code from permdock.com/create",
      valueHint: "code",
    },
    archetype: {
      type: "string",
      description:
        "Without --preset: b2b, agent, marketplace, api, internal or consumer",
      valueHint: "name",
    },
    framework: {
      type: "string",
      description: "Without --preset: next, hono, express or none",
      valueHint: "name",
    },
    feature: {
      type: "string",
      repeatable: true,
      description: "Without --preset: a feature to add",
      valueHint: "name",
    },
    integration: {
      type: "string",
      repeatable: true,
      description: "Without --preset: ai-sdk, mcp, shadcn or react-native",
      valueHint: "name",
    },
    "out-dir": {
      type: "string",
      description: "Source directory the files go in (default src)",
      valueHint: "dir",
    },
    ...dryRunFlag,
    ...forceFlag,
  },
  async run(ctx, { flags }) {
    const agents: string[] = [];
    const ui: string[] = [];
    for (const id of flags.integration) {
      if (AGENT_IDS.includes(id)) {
        agents.push(id);
      } else if (UI_IDS.includes(id)) {
        ui.push(id);
      } else {
        throw new CliError(
          "usage",
          `init: unknown --integration '${id}'.${suggestion(id, [...AGENT_IDS, ...UI_IDS])}`,
          { code: "invalid_value" },
        );
      }
    }
    // Lazy: the implementation loads only when this command runs, not for --help.
    const [{ runInit }, { packageManagerOf }] = await Promise.all([
      import("../init.ts"),
      import("../core/peer.ts"),
    ]);
    const agent = await packageManagerOf(ctx.cwd);
    const framework = given(flags.framework);
    // SAFETY: runInit rejects every id outside the catalogue before it resolves the preset.
    const selection = {
      archetype: given(flags.archetype) ?? "b2b",
      ...(framework === undefined ? {} : { framework }),
      features: flags.feature,
      agents,
      ui,
    } as PresetInput;
    const outDir = given(flags["out-dir"]);
    return runInit({
      cwd: ctx.cwd,
      preset: given(flags.preset) ?? selection,
      ...(outDir === undefined ? {} : { src: outDir }),
      dryRun: flags["dry-run"],
      force: flags.force,
      json: ctx.json,
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
  async run(ctx, { args }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runPreset } = await import("../init.ts");
    return runPreset("decode", args["code"], ctx.json);
  },
});

export const presetUrl: Leaf = defineLeaf({
  positionals: presetCode,
  flags: {},
  async run(ctx, { args }) {
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runPreset } = await import("../init.ts");
    return runPreset("url", args["code"], ctx.json);
  },
});
