import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Policy } from "../index.ts";
import type { DoctorInput, DoctorSource } from "./doctor-types.ts";
import type { CliIo, PermDockConfig } from "./types.ts";

import { type CollectOutcome, runCollect } from "./collect.ts";
import { doctorSrcPath, listSourceFiles, rel } from "./files.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";

export type PolicyLoad =
  | { readonly status: "unset" }
  | { readonly status: "loaded"; readonly policy: Policy }
  | {
      readonly status: "failed";
      readonly path: string;
      readonly message: string;
    };

/**
 * One command's view of the project: the config, the source files, the
 * policy module and the `collect --check` scan. Each load runs at most once,
 * on first use, so a `doctor --only` run reads only what its checks need.
 */
export type Project = Required<DoctorInput> & {
  readonly now: Date;
  readonly io: CliIo;
  /** The files under `doctor.srcPath`, else `collect.srcPath`, read once. */
  readonly sources: () => readonly DoctorSource[];
  readonly policyLoad: () => Promise<PolicyLoad>;
};

export function loadProject(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly now: Date;
  readonly io: CliIo;
}): Project {
  const { cwd, config } = input;
  let sources: readonly DoctorSource[] | undefined;
  let policyLoad: Promise<PolicyLoad> | undefined;
  let collected: Promise<CollectOutcome> | undefined;

  const loadPolicy = (): Promise<PolicyLoad> => {
    policyLoad ??= readPolicy(cwd, config.policy);
    return policyLoad;
  };
  const policy = async (): Promise<Policy | undefined> => {
    const load = await loadPolicy();
    return load.status === "loaded" ? load.policy : undefined;
  };

  return {
    cwd,
    config,
    now: input.now,
    io: input.io,
    sources: () => {
      sources ??= listSourceFiles(cwd, doctorSrcPath(config)).map((file) => ({
        file: rel(cwd, file),
        text: readFileSync(file, "utf8"),
      }));
      return sources;
    },
    policyLoad: loadPolicy,
    policy,
    collected: () => {
      collected ??= runCollect({
        cwd,
        config,
        collect: config.collect ?? {},
        scanPath: doctorSrcPath(config),
        check: true,
        now: input.now,
        io: input.io,
        loadPolicy: policy,
      });
      return collected;
    },
  };
}

async function readPolicy(
  cwd: string,
  path: string | undefined,
): Promise<PolicyLoad> {
  if (path === undefined) {
    return { status: "unset" };
  }
  try {
    const policy = asPolicy(
      pickNamed(await loadModule(resolve(cwd, path)), ["policy"]),
    );
    return { status: "loaded", policy };
  } catch (error) {
    return {
      status: "failed",
      path,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
