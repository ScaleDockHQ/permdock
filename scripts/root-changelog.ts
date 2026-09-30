import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { readPreState } from '@changesets/pre';
import { readChangesets } from '@changesets/read';
import { getPackages } from '@manypkg/get-packages';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs before `changeset version`, which deletes the changesets this reads.
const PRODUCT = 'permdock';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'CHANGELOG.md');

async function nextVersion(): Promise<string | undefined> {
  const packages = await getPackages(root);
  const parsed = await readConfig(root, packages);
  if (parsed.errors !== undefined) {
    throw new Error(parsed.errors.join('\n'));
  }
  const plan = assembleReleasePlan(
    await readChangesets(root),
    packages,
    parsed.config,
    await readPreState(root),
  );
  let version: string | undefined;
  for (const release of plan.releases) {
    if (release.name === PRODUCT || version === undefined) {
      version = release.newVersion;
    }
  }
  return version;
}

async function main(): Promise<string> {
  const summaries: string[] = [];
  for (const { summary } of await readChangesets(root)) {
    const trimmed = summary.trim();
    if (trimmed.length > 0) {
      summaries.push(`- ${trimmed.replaceAll('\n', '\n  ')}`);
    }
  }
  const version = summaries.length === 0 ? undefined : await nextVersion();
  if (version === undefined) {
    return 'nothing to release';
  }
  const date = new Date().toISOString().slice(0, 10);
  const section = `## ${version} (${date})\n\n${summaries.toSorted().join('\n')}\n`;

  const existing = await readFile(target, 'utf8');
  const first = existing.indexOf('\n## ');
  await writeFile(
    target,
    first === -1
      ? `${existing.trimEnd()}\n\n${section}`
      : `${existing.slice(0, first + 1)}${section}\n${existing.slice(first + 1)}`,
  );
  return version;
}

process.stdout.write(`root-changelog: ${await main()}\n`);
