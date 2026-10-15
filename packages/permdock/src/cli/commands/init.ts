import { defineCommand } from "citty";

import type { PresetInput } from "../../preset/index.ts";

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function init(ctx: CliContext): Command {
  return defineCommand({
    meta: { name: "init", description: COMMAND_DESCRIPTIONS.init },
    args: {
      ...globalArgs,
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
        description: "Without --preset: a feature to add, repeatable",
        valueHint: "name",
      },
      agent: {
        type: "string",
        description: "Without --preset: ai-sdk or mcp, repeatable",
        valueHint: "name",
      },
      ui: {
        type: "string",
        description: "Without --preset: shadcn or react-native, repeatable",
        valueHint: "name",
      },
      src: {
        type: "string",
        description: "Source directory the files go in (default src)",
        valueHint: "dir",
      },
      "dry-run": {
        type: "boolean",
        description: "Print what would be written; write nothing",
      },
      force: {
        type: "boolean",
        description: "Overwrite files that already exist",
      },
    },
    async run({ args: parsed, rawArgs }) {
      const { runInit } = await import("../init.ts");
      // SAFETY: runInit checks the archetype and resolvePreset drops ids outside the catalogue.
      const selection = {
        archetype: parsed.archetype ?? "b2b",
        ...(parsed.framework === undefined
          ? {}
          : { framework: parsed.framework }),
        features: listArg(rawArgs, "feature"),
        agents: listArg(rawArgs, "agent"),
        ui: listArg(rawArgs, "ui"),
      } as PresetInput;
      ctx.report(
        runInit({
          cwd: ctx.cwd,
          preset: parsed.preset ?? selection,
          ...(parsed.src === undefined ? {} : { src: parsed.src }),
          dryRun: parsed["dry-run"] === true,
          force: parsed.force === true,
          json: ctx.json,
        }),
      );
    },
  });
}
