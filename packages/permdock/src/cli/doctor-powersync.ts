import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DoctorFinding, DoctorInput } from "./doctor-types.ts";

import { policyOf } from "./doctor-collect.ts";
import { powersyncFile, powersyncOut } from "./powersync.ts";

/**
 * PD058: `sync-config.yaml` is not what the policy compiles to, so the
 * PowerSync service syncs rows by an older policy.
 */
export async function pd058(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const { cwd, config } = input;
  if (config.powersync === undefined || config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const out = powersyncOut(config);
  const path = resolve(cwd, out);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  let expected: string;
  try {
    expected = powersyncFile(policy, config).yaml;
  } catch {
    return [];
  }
  if (current === expected) {
    return [];
  }
  return [
    {
      code: "PD058",
      severity: "warning",
      message:
        current === undefined
          ? `${out} is missing, so PowerSync syncs no stream the policy compiles to`
          : `${out} is not what the policy compiles to, so PowerSync syncs rows by an older policy`,
      fix: "run permdock powersync generate and deploy the file to the PowerSync service",
    },
  ];
}
