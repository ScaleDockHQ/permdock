import { dirname, join } from "node:path";

import type { Project } from "../project/project.ts";
import type { DoctorFinding } from "../shared/doctor-types.ts";

const LOCKFILE = "pnpm-lock.yaml";
const MAX_LEVELS = 8;

/**
 * `permdock@0.21.0(react@19.1.0)(zod@4.1.0):` under `snapshots:`; the peers are
 * the parenthesised groups.
 */
const SNAPSHOT_KEY = /^ {2}'?permdock@([^(:'\s]+)((?:\([^)]*\))*)'?:\s*$/gmu;

/**
 * The body of the top-level `snapshots:` section. `packages:` lists the same
 * name once without peers, which is not a second copy.
 */
function snapshotsSection(lock: string): string {
  const start = /^snapshots:\s*$/mu.exec(lock);
  if (start === null) {
    return "";
  }
  const rest = lock.slice(start.index + start[0].length);
  const end = /^\S/mu.exec(rest.replace(/^\r?\n/u, ""));
  const body = rest.replace(/^\r?\n/u, "");
  return end === null ? body : body.slice(0, end.index);
}

function lockfileFrom(project: Project): string | undefined {
  let dir = project.cwd;
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    const candidate = join(dir, LOCKFILE);
    if (project.files.exists(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/**
 * PD092: `pnpm-lock.yaml` resolves one `permdock` version with two or more peer
 * sets, so an app loads two copies. Module state does not cross copies except
 * through `Symbol.for` brands.
 */
export function pd092(project: Project): readonly DoctorFinding[] {
  const lockfile = lockfileFrom(project);
  if (lockfile === undefined) {
    return [];
  }
  const variants = new Map<string, Set<string>>();
  for (const match of snapshotsSection(project.files.read(lockfile)).matchAll(
    SNAPSHOT_KEY,
  )) {
    const version = String(match[1]);
    const peers = variants.get(version) ?? new Set<string>();
    peers.add(String(match[2]));
    variants.set(version, peers);
  }
  return [...variants]
    .filter(([, peers]) => peers.size > 1)
    .map(([version, peers]): DoctorFinding => {
      const sets = [...peers].map((peer) =>
        peer === "" ? "(no peers)" : peer,
      );
      return {
        code: "PD092",
        severity: "warning",
        message: `${LOCKFILE} resolves permdock@${version} ${String(peers.size)} times: ${sets.join(" and ")}`,
        fix: "align the peer versions across workspace packages, or add a pnpm overrides entry for the peer that differs",
        target: `permdock@${version}`,
      };
    });
}
