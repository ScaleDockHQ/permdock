import type { Policy } from "../../index.ts";
import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { scopeMembershipTable } from "../../conditions/compile.ts";
import { scopeList } from "../../core/scopes.ts";
import { policyModel } from "../generate/model.ts";
import { powersyncOut } from "../powersync/emit/files.ts";
import { powersyncFiles, staleFiles } from "../powersync/powersync.ts";
import { roleSources, scopeSourcesOf, streamOf } from "../powersync/sources.ts";
import { filesOf } from "../shared/doctor-files.ts";
import { membershipSourcesOf } from "../sql/sources.ts";
import { policyOf } from "./inputs.ts";

/**
 * Why each membership source of a scope the streams read through sources has no
 * stream form, once per source.
 */
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
 * policy compiles to, so PowerSync syncs rows, or the device builds snapshots,
 * by an older policy. A policy that does not compile is a finding too, and so
 * is each membership source of a synced scope with no stream form: its members
 * sync none of the rows it grants.
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
    fix: "build the source with tableMembershipSource or junctionMembershipSource, without expiresAt, or serve its members from the server",
  }));
  const stale = staleFiles(cwd, compiled.files).map((file): DoctorFinding => ({
    code: "PD058",
    severity: "warning",
    message: file.missing
      ? `${file.path} is missing, so ${file.path === config.powersync?.manifest ? "the device builds no local snapshot" : "PowerSync syncs no stream the policy compiles to"}`
      : `${file.path} is not what the policy compiles to, so ${file.path === config.powersync?.manifest ? "the device builds snapshots" : "PowerSync syncs rows"} by an older policy`,
    fix: "run permdock powersync generate and deploy the files",
  }));
  return [
    ...stale,
    ...gaps,
    ...branchGaps(policy, config.powersync?.resources ?? []),
  ];
}

/**
 * A resource stream whose portable conditions have RLS text and no Sync Streams
 * text differs from `permitted_<resource>_match`, team level included.
 */
function branchGaps(
  policy: Policy,
  resources: readonly string[],
): readonly DoctorFinding[] {
  if (resources.length === 0) {
    return [];
  }
  const model = policyModel(policy);
  const grants = [
    ...model.grants,
    ...model.roles.flatMap((role) => role.grants),
  ];
  const findings: DoctorFinding[] = [];
  for (const resource of resources) {
    const diverged = grants.filter((grant) => {
      const where = grant.where;
      return (
        grant.permission === `${resource}.read` &&
        where !== undefined &&
        where.portable &&
        where.rls !== null &&
        where.stream === null
      );
    });
    if (diverged.length > 0) {
      findings.push({
        code: "PD058",
        severity: "error",
        target: resource,
        message: `stream ${resource} branches differ from permitted_${resource}_match: ${String(diverged.length)} condition has RLS text and no Sync Streams form`,
        fix: "give the condition a stream twin, or drop the resource from powersync.resources",
      });
    }
  }
  return findings;
}

/**
 * PD084: a synced stream reads a token claim. PowerSync keeps the claims a
 * connection started with, so after a role or tenant change the device syncs by
 * the old claims until the app refreshes the session and reconnects.
 */
export async function pd084(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const { config } = input;
  if (config.powersync === undefined || config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  let claims: readonly string[];
  try {
    ({ claims } = powersyncFiles(policy, config));
  } catch {
    // PD058 reports a policy that does not compile.
    return [];
  }
  return claims.map((message): DoctorFinding => ({
    code: "PD084",
    severity: "warning",
    message,
    fix: "pass nativeRefresh from permdock/react-native to refreshOn, which refreshes the session and reconnects PowerSync on each authz:<uid> message",
  }));
}

/**
 * PD102: a membership source reads `roles: "many"`, so each member of the
 * caller's tenants syncs their role rows, and `sync-config.yaml` still filters
 * the junction on the caller's own user id. Members then see only their own
 * roles on the device. The file is regenerated by `permdock powersync
 * generate`.
 */
export function pd102(input: DoctorInput): readonly DoctorFinding[] {
  const { cwd, config } = input;
  if (config.powersync === undefined) {
    return [];
  }
  const junctions = new Set<string>();
  for (const source of membershipSourcesOf(config)) {
    const stream = streamOf(source);
    if (typeof stream === "string" || typeof stream.roles !== "object") {
      continue;
    }
    if ("value" in stream.roles) {
      continue;
    }
    for (const role of roleSources(stream.roles)) {
      if (typeof role === "object" && "through" in role && role.many === true) {
        junctions.add(role.through.slice(role.through.lastIndexOf(".") + 1));
      }
    }
  }
  if (junctions.size === 0) {
    return [];
  }
  const path = powersyncOut(config);
  const files = filesOf(input);
  const file = `${cwd}/${path}`;
  if (!files.exists(file)) {
    return [];
  }
  const text = files.read(file);
  return [...junctions].flatMap((junction): readonly DoctorFinding[] => {
    const stale = `${junction}.user_id = auth.user_id()`;
    return text.includes(stale)
      ? [
          {
            code: "PD102",
            severity: "warning" as const,
            target: path,
            message: `${path} filters ${stale} while the membership source reads roles: "many", so a member syncs only their own role rows`,
            fix: "run permdock powersync generate and deploy the file",
          },
        ]
      : [];
  });
}
