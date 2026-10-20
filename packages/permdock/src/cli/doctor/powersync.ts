import type { Policy } from "../../index.ts";
import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { scopeMembershipTable } from "../../conditions/compile.ts";
import { scopeList } from "../../core/scopes.ts";
import { powersyncFiles, staleFiles } from "../powersync/powersync.ts";
import { scopeSourcesOf, streamOf } from "../powersync/sources.ts";
import { membershipSourcesOf } from "../sql/sources.ts";
import { policyOf } from "./inputs.ts";

/** Why each membership source of a scope the streams read through sources has no stream form, once per source. */
function sourceGaps(policy: Policy, config: PermDockConfig): readonly string[] {
  const scopes = scopeList(policy.scopes);
  const sources = membershipSourcesOf(config);
  const gaps = new Set<string>();
  for (const scope of scopes) {
    if (
      scopeMembershipTable(config.rls?.memberships, scopes, scope.name) !==
      undefined
    ) {
      continue;
    }
    for (const source of scopeSourcesOf(sources, scope.name)) {
      const stream = streamOf(source);
      if (typeof stream === "string") {
        gaps.add(stream);
      }
    }
  }
  return [...gaps];
}

/**
 * PD058: `sync-config.yaml` or the `powersync.manifest` file is not what the
 * policy compiles to, so PowerSync syncs rows, or the device builds
 * snapshots, by an older policy. A policy that does not compile is a finding
 * too, and so is each membership source of a synced scope with no stream
 * form: its members sync none of the rows it grants.
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
  const gaps = sourceGaps(policy, config).map((gap): DoctorFinding => ({
    code: "PD058",
    severity: "warning",
    message: gap,
    fix: "build the source with tableMembershipSource or junctionMembershipSource, without expiresAt or disabledAt, or serve its members from the server",
  }));
  const stale = staleFiles(cwd, compiled.files).map((file): DoctorFinding => ({
    code: "PD058",
    severity: "warning",
    message: file.missing
      ? `${file.path} is missing, so ${file.path === config.powersync?.manifest ? "the device builds no local snapshot" : "PowerSync syncs no stream the policy compiles to"}`
      : `${file.path} is not what the policy compiles to, so ${file.path === config.powersync?.manifest ? "the device builds snapshots" : "PowerSync syncs rows"} by an older policy`,
    fix: "run permdock powersync generate and deploy the files",
  }));
  return [...stale, ...gaps];
}
