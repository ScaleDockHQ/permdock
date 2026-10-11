import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

import type { DoctorFiles, DoctorInput } from "./doctor-types.ts";

export const nodeFiles: DoctorFiles = Object.freeze({
  exists: (path: string) => existsSync(path),
  read: (path: string) => readFileSync(path, "utf8"),
  list: (path: string) => readdirSync(path),
  isDirectory: (path: string) =>
    statSync(path, { throwIfNoEntry: false })?.isDirectory() === true,
});

export function filesOf(input: Pick<DoctorInput, "files">): DoctorFiles {
  return input.files ?? nodeFiles;
}

/** Parses the JSON file at `path`; throws when it is missing or invalid. */
export function readJson(files: DoctorFiles, path: string): unknown {
  return JSON.parse(files.read(path));
}
