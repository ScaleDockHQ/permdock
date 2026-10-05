import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "./package-root.ts";

export function cliVersion(): string {
  // SAFETY: packageRoot() finds permdock's own package.json, which always has a version.
  const raw = JSON.parse(
    readFileSync(join(packageRoot(), "package.json"), "utf8"),
  ) as {
    readonly version: string;
  };
  return raw.version;
}

export function generatorBanner(): string {
  return `permdock@${cliVersion()}`;
}

export const CATALOG_SCHEMA =
  "https://permdock.com/schemas/catalog-v1.json" as const;
export const SUPABASE_MANIFEST_SCHEMA =
  "https://permdock.com/schemas/supabase-manifest-v1.json" as const;
export const USAGE_REPORT_SCHEMA =
  "https://permdock.com/schemas/usage-report-v1.json" as const;
export const DOCTOR_REPORT_SCHEMA =
  "https://permdock.com/schemas/doctor-report-v1.json" as const;
export const CONFIG_REPORT_SCHEMA =
  "https://permdock.com/schemas/config-report-v1.json" as const;
