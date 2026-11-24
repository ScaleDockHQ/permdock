import type { DoctorFinding } from "../shared/doctor-types.ts";
import type { SqlText } from "../sql/exported-copies.ts";

import {
  generatedByPermdock,
  inReservedDir,
  ownedObjects,
  shownKey,
  withoutOwned,
} from "../sql/exported-copies.ts";

/**
 * PD095: a schema file the app or an export wrote creates a function or policy
 * a PermDock file also creates. The shadow load then applies both, and the
 * later file wins. Files in `_custom/` and `_cluster/` are left out.
 */
export async function exportedDuplicates(
  schemaDir: string,
  files: readonly SqlText[],
): Promise<readonly DoctorFinding[]> {
  const ownFile = new Map<string, string>();
  for (const file of files) {
    if (generatedByPermdock(file.text)) {
      for (const key of await ownedObjects([file.text])) {
        ownFile.set(key, file.path);
      }
    }
  }
  if (ownFile.size === 0) {
    return [];
  }
  const owned = new Set(ownFile.keys());
  const findings: DoctorFinding[] = [];
  for (const file of files) {
    if (generatedByPermdock(file.text) || inReservedDir(schemaDir, file.path)) {
      continue;
    }
    const { removed } = await withoutOwned(file.text, owned);
    for (const key of removed) {
      findings.push({
        code: "PD095",
        severity: "error",
        target: file.path,
        message: `${file.path} and ${ownFile.get(key) ?? ""} both create ${shownKey(key)}`,
        fix: "run permdock generate, which removes the exported copy, or delete it by hand",
      });
    }
  }
  return findings;
}
