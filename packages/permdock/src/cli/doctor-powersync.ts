import type { DoctorFinding, DoctorInput } from "./doctor-types.ts";

import { policyOf } from "./doctor-collect.ts";
import { powersyncFiles, staleFiles } from "./powersync.ts";

/**
 * PD058: `sync-config.yaml` or the `powersync.manifest` file is not what the
 * policy compiles to, so PowerSync syncs rows, or the device builds
 * snapshots, by an older policy. A policy that does not compile is a finding
 * too.
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
  let compiled: ReturnType<typeof powersyncFiles>;
  try {
    compiled = powersyncFiles(policy, config);
  } catch (cause) {
    return [
      {
        code: "PD058",
        severity: "warning",
        message: `the policy does not compile to Sync Streams: ${cause instanceof Error ? cause.message : String(cause)}`,
        fix: "fix the powersync and rls config, then run permdock powersync generate",
      },
    ];
  }
  return staleFiles(cwd, compiled.files).map((file) => ({
    code: "PD058",
    severity: "warning",
    message: file.missing
      ? `${file.path} is missing, so ${file.path === config.powersync?.manifest ? "the device builds no local snapshot" : "PowerSync syncs no stream the policy compiles to"}`
      : `${file.path} is not what the policy compiles to, so ${file.path === config.powersync?.manifest ? "the device builds snapshots" : "PowerSync syncs rows"} by an older policy`,
    fix: "run permdock powersync generate and deploy the files",
  }));
}
