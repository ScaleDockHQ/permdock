import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Publishes `permdock` from changesets/action (`publish-script`). `pnpm pack`
// rewrites `catalog:` and `workspace:` ranges; `npm publish` then authenticates
// through npm trusted publishing (OIDC), so no npm token exists anywhere.
// `changeset git-tag` writes the tag to CHANGESETS_OUTPUT, which the action
// reads to push the tag and create the GitHub release.

interface PreState {
  readonly mode: 'pre' | 'exit';
  readonly tag: string;
}

interface Manifest {
  readonly name: string;
  readonly version: string;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = join(ROOT, 'packages', 'permdock');
const REGISTRY = 'https://registry.npmjs.org';

const { values } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false } },
});
const dryRun = values['dry-run'];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readPreState(): PreState | undefined {
  const path = join(ROOT, '.changeset', 'pre.json');
  return existsSync(path) ? (readJson(path) as PreState) : undefined;
}

// `pre exit` leaves pre.json in `exit` mode until `changeset version` runs, so
// a prerelease version still belongs to the pre tag until it is versioned out.
function distTag(version: string): string {
  const pre = readPreState();
  const prerelease = version.includes('-');
  if (pre !== undefined && (pre.mode === 'pre' || prerelease)) {
    return pre.tag;
  }
  if (prerelease) {
    throw new Error(
      `${version} is a prerelease but .changeset/pre.json is missing; refusing to publish it as latest`,
    );
  }
  return 'latest';
}

async function isPublished({ name, version }: Manifest): Promise<boolean> {
  const response = await fetch(
    `${REGISTRY}/${name.replace('/', '%2F')}/${version}`,
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(
      `${name}@${version}: registry lookup failed with HTTP ${String(response.status)}`,
    );
  }
  return true;
}

function pack(): string {
  if (!existsSync(join(PACKAGE_DIR, 'dist'))) {
    throw new Error(
      'packages/permdock/dist is missing; run `pnpm run build` first',
    );
  }
  const destination = mkdtempSync(
    join(process.env['RUNNER_TEMP'] ?? tmpdir(), 'permdock-pack-'),
  );
  execFileSync('pnpm', ['pack', '--pack-destination', destination], {
    cwd: PACKAGE_DIR,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tarballs = readdirSync(destination).filter((file) =>
    file.endsWith('.tgz'),
  );
  if (tarballs.length !== 1) {
    throw new Error(
      `expected one tarball in ${destination}, found ${String(tarballs.length)}`,
    );
  }
  return join(destination, tarballs[0] ?? '');
}

const manifest = readJson(join(PACKAGE_DIR, 'package.json')) as Manifest;
const tag = distTag(manifest.version);
const published = await isPublished(manifest);
const tarball = pack();
const publishArgs = [
  'publish',
  tarball,
  '--access',
  'public',
  '--provenance',
  '--tag',
  tag,
];

process.stdout.write(
  [
    `package: ${manifest.name}@${manifest.version}`,
    `tarball: ${tarball}`,
    `tag: ${tag}`,
    `command: npm ${publishArgs.join(' ')}`,
    published ? 'registry: already published, npm publish is skipped' : '',
  ]
    .filter(Boolean)
    .join('\n') + '\n',
);

if (!dryRun) {
  if (!published) {
    execFileSync('npm', publishArgs, { cwd: ROOT, stdio: 'inherit' });
  }
  execFileSync('pnpm', ['exec', 'changeset', 'git-tag'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}
