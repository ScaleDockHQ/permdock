import { dirname, join, resolve } from "node:path";

import type { DoctorFiles } from "./doctor-types.ts";

import { readJson } from "./doctor-files.ts";

/**
 * The directories from `cwd` up to the workspace root: the first one with a
 * `pnpm-workspace.yaml`, a `package.json` that declares `workspaces`, or a
 * `.git`. Skills are often installed once at a monorepo's root.
 */
export function workspaceDirs(
  files: DoctorFiles,
  cwd: string,
): readonly string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  for (;;) {
    dirs.push(dir);
    if (isWorkspaceRoot(files, dir)) {
      return dirs;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return [resolve(cwd)];
    }
    dir = parent;
  }
}

function isWorkspaceRoot(files: DoctorFiles, dir: string): boolean {
  if (
    files.exists(join(dir, "pnpm-workspace.yaml")) ||
    files.exists(join(dir, ".git"))
  ) {
    return true;
  }
  const manifest = join(dir, "package.json");
  if (!files.exists(manifest)) {
    return false;
  }
  try {
    const parsed: unknown = readJson(files, manifest);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      Object.hasOwn(parsed, "workspaces")
    );
  } catch {
    return false;
  }
}
