import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The official JSON Schemas `permdock openapi` output is validated against.
// Each URL is the schema's `$id`; bumping a revision means changing it here.
const SCHEMAS = {
  'oas-3.1.json': 'https://spec.openapis.org/oas/3.1/schema/2022-10-07',
  'oas-3.2.json': 'https://spec.openapis.org/oas/3.2/schema/2025-09-17',
  'overlay-1.1.json': 'https://spec.openapis.org/overlay/1.1/schema/2026-04-01',
} as const;

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'permdock',
  'schemas',
  'openapi',
);

async function fetchSchema(file: string, url: string): Promise<void> {
  const response = await fetch(url, {
    headers: { accept: 'application/schema+json, application/json' },
  });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)}`);
  }
  const target = join(out, file);
  await writeFile(
    target,
    `${JSON.stringify(await response.json(), null, 2)}\n`,
  );
  process.stdout.write(`wrote ${target}\n`);
}

await Promise.all(
  Object.entries(SCHEMAS).map(
    async ([file, url]: readonly [string, string]) => {
      await fetchSchema(file, url);
    },
  ),
);
