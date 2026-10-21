import type { Agent } from "package-manager-detector";

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CommandResult, NextStep } from "./core/result.ts";

import {
  type Preset,
  type PresetInput,
  decodePreset,
  encodePreset,
  generatePreset,
  presetFlags,
  resolvePreset,
} from "../preset/index.ts";
import { CliError } from "./core/errors.ts";
import { applyFiles } from "./core/files.ts";
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
  /** The package manager the install line names; npm when unset. */
  readonly agent?: Agent;
};

/** What `permdock init --json` reports as `data`. */
export type InitReport = {
  readonly preset: string;
  readonly written: readonly string[];
  readonly kept: readonly string[];
  readonly dryRun: boolean;
  readonly install: string;
  readonly shadcn: string | null;
  readonly docs: readonly string[];
};

function decoded(code: string, command: string): Preset {
  const preset = decodePreset(code);
  if (preset === undefined) {
    throw new CliError(
      "usage",
      `${command}: '${code}' is not a preset code this version reads; build one at ${CREATE_URL}`,
      { code: "invalid_value" },
    );
  }
  return preset;
}

/**
 * Writes the preset's owned files into `cwd` and lists what to install. An
 * existing file is kept unless `force` is set, so `init` never overwrites code
 * the application already changed. It installs nothing and calls no network:
 * the package manager and shadcn commands are printed for the person to run.
 */
export function runInit(options: InitOptions): CommandResult {
  const preset =
    typeof options.preset === "string"
      ? decoded(options.preset, "init")
      : resolvePreset(options.preset);
  const generated = generatePreset(
    preset,
    options.src === undefined ? {} : { src: options.src },
  );
  const writes = generated.files.filter(
    (file) =>
      options.force === true || !existsSync(join(options.cwd, file.path)),
  );
  const written = writes.map((file) => file.path);
  const kept = generated.files
    .filter((file) => !writes.includes(file))
    .map((file) => file.path);
  const dryRun = options.dryRun === true;
  applyFiles(
    options.cwd,
    writes.map((file) => ({ path: file.path, text: file.contents })),
    { dryRun },
  );
  const install = addLine(options.agent, generated.dependencies);
  const shadcn =
    generated.recipes.length === 0
      ? null
      : `npx shadcn@latest add ${generated.recipes.join(" ")}`;
  const next: NextStep[] = [
    { command: install, when: "to add the dependencies the files import" },
    ...(shadcn === null
      ? []
      : [{ command: shadcn, when: "to add the @permdock UI recipes" }]),
    {
      command: "npx permdock doctor",
      when: "after the install, to check the policy and the wiring",
    },
  ];
  const data: InitReport = {
    preset: generated.code,
    written,
    kept,
    dryRun,
    install,
    shadcn,
    docs: generated.docs,
  };
  const lines = [
    `Preset ${generated.code} (${preset.archetype}, ${preset.framework}, ${preset.auth}, ${preset.backend})${dryRun ? " — dry run, nothing written" : ""}`,
    "",
    ...written.map((path) => `  ${dryRun ? "would write" : "wrote"} ${path}`),
    ...kept.map((path) => `  kept ${path} (exists; --force overwrites)`),
    "",
    "Next:",
    ...next.map((step) => `  ${step.command}`),
    "",
    `Read: ${generated.docs.map((page) => `https://permdock.com${page}`).join(", ")}`,
    `Edit this preset: ${CREATE_URL}?preset=${generated.code}`,
  ];
  return { code: 0, output: `${lines.join("\n")}\n`, data, next };
}

/** `permdock preset decode|url <code>`: what a code holds, or its builder link. */
export function runPreset(
  action: "decode" | "url",
  code: string,
): CommandResult {
  const command = `preset ${action}`;
  const preset = decoded(code, command);
  const url = `${CREATE_URL}?preset=${encodePreset(preset)}`;
  if (action === "url") {
    return { code: 0, output: `${url}\n`, data: { url } };
  }
  const rows = Object.entries(preset).map(
    ([key, value]) =>
      `  ${key.padEnd(12)} ${Array.isArray(value) ? value.join(", ") || "none" : String(value)}`,
  );
  return {
    code: 0,
    output: `${[...rows, "", `  permdock init ${presetFlags(preset).join(" ")}`].join("\n")}\n`,
    data: preset,
  };
}
