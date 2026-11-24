import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { DoctorFiles, DoctorFinding } from "../shared/doctor-types.ts";

import { isRecord } from "../../core/compact.ts";
import { nodeFiles } from "../shared/doctor-files.ts";

/** The parsers `permdock` pins exactly, because its findings depend on them. */
const PINNED_PARSERS = ["oxc-parser", "pgsql-parser"] as const;

type Parser = (typeof PINNED_PARSERS)[number];

function versionOf(from: string, name: string): string | undefined {
  try {
    const pkg: unknown = createRequire(from)(`${name}/package.json`);
    return isRecord(pkg) && typeof pkg["version"] === "string"
      ? pkg["version"]
      : undefined;
  } catch {
    return undefined;
  }
}

/** The versions of the parsers this `permdock` copy resolves. */
export function permdockParserVersions(): Readonly<
  Partial<Record<Parser, string>>
> {
  return Object.fromEntries(
    PINNED_PARSERS.flatMap((name) => {
      const version = versionOf(import.meta.url, name);
      return version === undefined ? [] : [[name, version]];
    }),
  );
}

function listed(
  files: DoctorFiles,
  cwd: string,
): Readonly<Record<string, string>> {
  const path = resolve(cwd, "package.json");
  if (!files.exists(path)) {
    return {};
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(files.read(path));
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    const deps = isRecord(pkg) ? pkg[field] : undefined;
    if (!isRecord(deps)) {
      continue;
    }
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string") {
        out[name] = spec;
      }
    }
  }
  return out;
}

/**
 * PD126: the app lists `oxc-parser` or `pgsql-parser` and installs another
 * version than the one `permdock` pins, so the project holds two copies.
 */
export function pd126(
  cwd: string,
  files: DoctorFiles = nodeFiles,
  own: Readonly<Partial<Record<Parser, string>>> = permdockParserVersions(),
): readonly DoctorFinding[] {
  const deps = listed(files, cwd);
  return PINNED_PARSERS.flatMap((name) => {
    const spec = deps[name];
    const pinned = own[name];
    if (spec === undefined || pinned === undefined) {
      return [];
    }
    const installed = versionOf(resolve(cwd, "package.json"), name);
    if (installed === undefined || installed === pinned) {
      return [];
    }
    return [
      {
        code: "PD126",
        severity: "info" as const,
        target: name,
        message: `package.json lists ${name} ${spec}, which installs ${installed}; permdock pins ${pinned}, so the project holds two copies`,
        fix: `remove ${name} from package.json: permdock depends on it at the version its findings are tested with`,
      },
    ];
  });
}
