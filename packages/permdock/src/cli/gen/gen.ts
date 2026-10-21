import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { OutputFile } from "../core/output-files.ts";
import type { CommandResult } from "../core/result.ts";
import type { GenKind, PermDockConfig } from "../types.ts";
import type { GenModel } from "./model.ts";

import { loadConfiguredOperations } from "../catalog-operations.ts";
import { CliError, configError } from "../core/errors.ts";
import { fileSummary, planFiles } from "../core/files.ts";
import { STDOUT, driftOf, writeOutputFiles } from "../core/output-files.ts";
import { requirePolicy } from "../project/load.ts";
import { constantsModule } from "./constants.ts";
import { factoriesModule } from "./factories.ts";
import { hooksModule, policySpecifier } from "./hooks.ts";
import { messagesDocument } from "./messages.ts";
import { genModel } from "./model.ts";
import {
  jsonSchemaDocument,
  standardSchemaModule,
  validatorModule,
} from "./schemas.ts";

const GEN_KINDS = [
  "constants",
  "zod",
  "valibot",
  "arktype",
  "json-schema",
  "standard-schema",
  "factories",
  "react",
  "vue",
  "svelte",
  "solid",
  "messages",
] as const satisfies readonly GenKind[];

const DEFAULT_GEN_OUT = "src/generated";

const FILE_NAMES: Readonly<Record<GenKind, string>> = {
  constants: "permdock.generated.ts",
  zod: "permdock.zod.ts",
  valibot: "permdock.valibot.ts",
  arktype: "permdock.arktype.ts",
  "json-schema": "permdock.schemas.json",
  "standard-schema": "permdock.schemas.ts",
  factories: "permdock.factories.ts",
  react: "permdock.react.ts",
  vue: "permdock.vue.ts",
  svelte: "permdock.svelte-stores.ts",
  solid: "permdock.solid.ts",
  messages: "permdock.messages.json",
};

function isGenKind(value: unknown): value is GenKind {
  return GEN_KINDS.some((kind) => kind === value);
}

function kindsOf(
  flags: readonly GenKind[],
  config: PermDockConfig,
): readonly GenKind[] {
  if (flags.length > 0) {
    return [...new Set(flags)];
  }
  const configured = config.gen?.kinds;
  if (configured === undefined) {
    return ["constants"];
  }
  for (const kind of configured) {
    if (!isGenKind(kind)) {
      throw configError(
        `PermDock CLI: gen.kinds has '${String(kind)}'; use ${GEN_KINDS.join(", ")}`,
      );
    }
  }
  return [...new Set(configured)];
}

type RenderContext = {
  readonly fieldMeta: boolean;
  /** The output path as given; `-` for stdout. */
  readonly rel: string;
  /**
   * The output file, absolute; the default file name under the directory for
   * stdout.
   */
  readonly file: string;
  /** The policy module, absolute. */
  readonly policy: string;
  readonly previous: string | undefined;
};

function readIfExists(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function render(
  kind: GenKind,
  model: GenModel,
  context: RenderContext,
): string {
  switch (kind) {
    case "constants":
      return constantsModule(model);
    case "zod":
    case "valibot":
    case "arktype":
      return validatorModule(kind, model, context);
    case "json-schema":
      return jsonSchemaDocument(model);
    case "standard-schema":
      return standardSchemaModule(model, context);
    case "factories":
      return factoriesModule(model);
    case "react":
    case "vue":
    case "svelte":
    case "solid":
      return hooksModule(kind, policySpecifier(context.file, context.policy));
    case "messages":
      return messagesDocument(model, context.rel, context.previous);
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export type GenInput = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly kinds: readonly GenKind[];
  readonly out?: string;
  readonly outDir?: string;
  readonly from?: string;
  readonly check: boolean;
  readonly dryRun: boolean;
};

/** The files `permdock gen` writes: one per kind under the output directory. */
async function genFiles(input: GenInput): Promise<readonly OutputFile[]> {
  const kinds = kindsOf(input.kinds, input.config);
  if (input.out !== undefined && kinds.length > 1) {
    throw new CliError(
      "usage",
      `gen: --out names one file; ${String(kinds.length)} kinds need --out-dir`,
      { code: "invalid_value", extensions: { flag: "--out" } },
    );
  }
  const policyPath = input.from ?? input.config.policy ?? "";
  const policy = await requirePolicy(
    input.cwd,
    input.from ?? input.config.policy,
    "gen needs policy in the config or --policy",
  );
  const operations = await loadConfiguredOperations(
    input.cwd,
    input.config.operations,
  );
  const model = genModel({ policy, config: input.config, operations });
  const dir = input.outDir ?? input.config.gen?.out ?? DEFAULT_GEN_OUT;
  const fieldMeta = input.config.gen?.fieldMeta === true;
  return kinds.map((kind) => {
    const rel = input.out ?? `${dir}/${FILE_NAMES[kind]}`;
    const file = resolve(
      input.cwd,
      rel === STDOUT ? `${dir}/${FILE_NAMES[kind]}` : rel,
    );
    return {
      part: kind,
      rel,
      text: render(kind, model, {
        fieldMeta,
        rel,
        file,
        policy: resolve(input.cwd, policyPath),
        previous: rel === STDOUT ? undefined : readIfExists(file),
      }),
    };
  });
}

export async function runGen(input: GenInput): Promise<CommandResult> {
  const files = await genFiles(input);
  if (input.check) {
    const drift = driftOf(input.cwd, files);
    return drift.length === 0
      ? {
          code: 0,
          output: files.map((file) => `${file.rel} is current`).join("\n"),
          data: { stale: [] },
        }
      : {
          code: 1,
          output: `${drift.join("\n")}\nrun permdock gen to refresh`,
          data: { stale: drift },
        };
  }
  const onDisk = files
    .filter((file) => file.rel !== STDOUT)
    .map((file) => ({ path: file.rel, text: file.text }));
  if (input.dryRun) {
    const planned = planFiles(input.cwd, onDisk);
    return {
      code: 0,
      output: fileSummary(planned, true),
      data: { files: planned },
    };
  }
  const planned = planFiles(input.cwd, onDisk);
  const { printed } = writeOutputFiles(input.cwd, files);
  return {
    code: 0,
    output: printed === "" ? fileSummary(planned, false) : printed,
    data: { files: planned },
  };
}
