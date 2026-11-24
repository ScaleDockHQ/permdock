import type { Policy } from "../../../index.ts";
import type { PermDockConfig } from "../../types.ts";

import { localSnapshotManifest } from "../../../index.ts";
import { claimWarnings } from "../claims.ts";
import { localRows } from "../rows.ts";
import { powersyncPlan } from "../streams.ts";
import { powersyncYaml } from "../yaml.ts";
import { publicationFile } from "./publication.ts";

const DEFAULT_OUT = "sync-config.yaml";

export function powersyncOut(config: PermDockConfig, out?: string): string {
  return out ?? config.powersync?.out ?? DEFAULT_OUT;
}

export type PowerSyncFile = {
  readonly path: string;
  readonly text: string;
  /** Compared as parsed JSON, so a formatter run over the file keeps it current. */
  readonly json?: true;
};

export function sameJson(current: string, expected: string): boolean {
  try {
    return (
      JSON.stringify(JSON.parse(current)) ===
      JSON.stringify(JSON.parse(expected))
    );
  } catch {
    return false;
  }
}

/**
 * The files the policy compiles to: the Sync Streams file and, with
 * `powersync.manifest`, the local-snapshot manifest. `warnings` lists the
 * grants that do not sync.
 */
export function powersyncFiles(
  policy: Policy,
  config: PermDockConfig,
  out?: string,
  /** The schema file for the publication statement; see `publicationPath`. */
  publicationAt?: string,
): {
  readonly files: readonly PowerSyncFile[];
  readonly warnings: readonly string[];
  /** PD084: one line per stream that reads a token claim. */
  readonly claims: readonly string[];
  readonly publication?: string;
  /** Whether a schema file holds the publication statement. */
  readonly publicationWritten: boolean;
} {
  const plan = powersyncPlan(policy, config);
  const written = publicationAt !== undefined && plan.publication !== undefined;
  const files: PowerSyncFile[] = [
    {
      path: powersyncOut(config, out),
      text: powersyncYaml(plan, { publicationComment: !written }),
    },
  ];
  if (written) {
    files.push(publicationFile(publicationAt, plan.publication));
  }
  const manifest = config.powersync?.manifest;
  if (manifest !== undefined) {
    files.push({
      path: manifest,
      json: true,
      text: `${JSON.stringify(
        {
          ...localSnapshotManifest(policy),
          rows: localRows(policy, config, plan.devices),
        },
        null,
        2,
      )}\n`,
    });
  }
  return {
    files,
    warnings: plan.warnings,
    claims: claimWarnings(plan.streams),
    ...(plan.publication === undefined
      ? {}
      : { publication: plan.publication }),
    publicationWritten: written,
  };
}
