import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageRoot } from './package-root.ts';

export function cliVersion(): string {
  const raw = JSON.parse(
    readFileSync(join(packageRoot(), 'package.json'), 'utf8'),
  ) as {
    readonly version: string;
  };
  return raw.version;
}

export function generatorBanner(): string {
  return `permdock@${cliVersion()}`;
}

export const CATALOG_SCHEMA =
  'https://permdock.dev/schemas/catalog-v1.json' as const;
export const USAGE_REPORT_SCHEMA =
  'https://permdock.dev/schemas/usage-report-v1.json' as const;
export const DOCTOR_REPORT_SCHEMA =
  'https://permdock.dev/schemas/doctor-report-v1.json' as const;
