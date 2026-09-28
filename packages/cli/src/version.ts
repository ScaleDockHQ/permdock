import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'package.json',
);

export function cliVersion(): string {
  const raw = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    readonly version: string;
  };
  return raw.version;
}

export function generatorBanner(): string {
  return `@permdock/cli@${cliVersion()}`;
}

export const CATALOG_SCHEMA =
  'https://permdock.dev/schemas/catalog-v1.json' as const;
export const USAGE_REPORT_SCHEMA =
  'https://permdock.dev/schemas/usage-report-v1.json' as const;
export const DOCTOR_REPORT_SCHEMA =
  'https://permdock.dev/schemas/doctor-report-v1.json' as const;
