import type { Agent } from "package-manager-detector";

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CommandResult } from "./core/result.ts";

import {
  type Preset,
  type PresetInput,
  AGENTS,
  ARCHETYPES,
  FEATURES,
  FRAMEWORKS,
  UI,
  decodePreset,
  encodePreset,
  generatePreset,
  resolvePreset,
} from "../preset/index.ts";
import { didYouMean } from "./core/args.ts";
import { addLine } from "./core/peer.ts";

/** The page a preset code opens in the builder. */
const CREATE_URL = "https://permdock.com/create";

export type InitOptions = {
  readonly cwd: string;
  /** A preset code from /create, or a selection from flags. */
  readonly preset: string | PresetInput;
  readonly src?: string;
  readonly dryRun?: boolean;
  /** Overwrite files that already exist; off by default. */
  readonly force?: boolean;
  readonly json?: boolean;
  /** The package manager the install line names; npm when unset. */
  readonly agent?: Agent;
};

/** The first id outside its catalogue, as a message naming the flag and the choices. */
function unknownChoice(input: PresetInput): string | undefined {
  const groups: readonly [
    string,
    readonly string[],
    readonly { readonly id: string }[],
  ][] = [
    ["--archetype", [input.archetype], ARCHETYPES],
    [
      "--framework",
      input.framework === undefined ? [] : [input.framework],
      FRAMEWORKS,
    ],
    ["--feature", input.features ?? [], FEATURES],
    ["--integration", input.agents ?? [], AGENTS],
    ["--integration", input.ui ?? [], UI],
  ];
  for (const [flag, picked, choices] of groups) {
    const ids = choices.map((choice) => choice.id);
    const unknown = picked.find((id) => !ids.includes(id));
    if (unknown !== undefined) {
      const suggestion = didYouMean(unknown, ids);
      return `unknown ${flag} '${unknown}'${suggestion === undefined ? "" : ` (did you mean ${suggestion}?)`}; pick one of ${ids.join(", ")}`;
    }
  }
  return undefined;
}

function presetOf(input: string | PresetInput): Preset | string {
  if (typeof input !== "string") {
    return unknownChoice(input) ?? resolvePreset(input);
  }
  return (
    decodePreset(input) ??
    `'${input}' is not a preset code this version reads; build one at ${CREATE_URL}`
  );
}

/**
 * Writes the preset's owned files into `cwd` and prints what to install.
 * An existing file is kept unless `force` is set, so `init` never
 * overwrites code the application already changed. It installs nothing
 * and calls no network: the package manager and shadcn commands are
 * printed for the person to run.
 */
export function runInit(options: InitOptions): CommandResult {
  const preset = presetOf(options.preset);
  if (typeof preset === "string") {
    return { code: 2, output: `permdock init: ${preset}\n` };
  }
  const generated = generatePreset(
    preset,
    options.src === undefined ? {} : { src: options.src },
  );
  const written: string[] = [];
  const kept: string[] = [];
  for (const file of generated.files) {
    const target = join(options.cwd, file.path);
    if (existsSync(target) && options.force !== true) {
      kept.push(file.path);
      continue;
    }
    written.push(file.path);
    if (options.dryRun !== true) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.contents);
    }
  }
  const install = addLine(options.agent, generated.dependencies);
  const shadcn =
    generated.recipes.length === 0
      ? undefined
      : `npx shadcn@latest add ${generated.recipes.join(" ")}`;
  if (options.json === true) {
    return {
      code: 0,
      output: `${JSON.stringify(
        {
          preset: generated.code,
          written,
          kept,
          dryRun: options.dryRun === true,
          install,
          shadcn: shadcn ?? null,
          docs: generated.docs,
        },
        null,
        2,
      )}\n`,
    };
  }
  const lines = [
    `Preset ${generated.code} (${preset.archetype}, ${preset.framework})${options.dryRun === true ? " — dry run, nothing written" : ""}`,
    "",
    ...written.map(
      (path) =>
        `  ${options.dryRun === true ? "would write" : "wrote"} ${path}`,
    ),
    ...kept.map((path) => `  kept ${path} (exists; --force overwrites)`),
    "",
    "Next:",
    `  ${install}`,
    ...(shadcn === undefined ? [] : [`  ${shadcn}`]),
    "  npx permdock doctor",
    "",
    `Read: ${generated.docs.map((page) => `https://permdock.com${page}`).join(", ")}`,
    `Edit this preset: ${CREATE_URL}?preset=${generated.code}`,
  ];
  return { code: 0, output: `${lines.join("\n")}\n` };
}

/** `permdock preset decode|url <code>`: what a code holds, or its builder link. */
export function runPreset(
  action: string | undefined,
  code: string | undefined,
  json: boolean,
): CommandResult {
  if (code === undefined || (action !== "decode" && action !== "url")) {
    return {
      code: 2,
      output: "permdock preset: usage: permdock preset decode|url <code>\n",
    };
  }
  const preset = decodePreset(code);
  if (preset === undefined) {
    return {
      code: 2,
      output: `permdock preset: '${code}' is not a preset code this version reads\n`,
    };
  }
  if (action === "url") {
    return {
      code: 0,
      output: `${CREATE_URL}?preset=${encodePreset(preset)}\n`,
    };
  }
  if (json) {
    return { code: 0, output: `${JSON.stringify(preset, null, 2)}\n` };
  }
  const rows = Object.entries(preset).map(
    ([key, value]) =>
      `  ${key.padEnd(10)} ${Array.isArray(value) ? value.join(", ") || "none" : String(value)}`,
  );
  return { code: 0, output: `${rows.join("\n")}\n` };
}
