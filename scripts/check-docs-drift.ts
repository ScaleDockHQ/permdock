import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'apps', 'docs', 'content', 'docs');
const CLI_SRC = join(ROOT, 'packages', 'cli', 'src');

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path, keep));
    } else if (keep(path)) {
      out.push(path);
    }
  }
  return out;
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const cliSources = walk(
  CLI_SRC,
  (file) => file.endsWith('.ts') && !file.includes('.test.'),
).map(read);
const cliDocs = walk(join(DOCS, 'cli'), (file) => file.endsWith('.mdx'))
  .map(read)
  .join('\n');
const allDocs = walk(DOCS, (file) => file.endsWith('.mdx'))
  .map(read)
  .join('\n');

function cliFlags(): readonly string[] {
  const flags = new Set<string>();
  const pattern =
    /flag(?:Bool|String|List|Number)\(\s*args\.flags,\s*'([^']+)'/gu;
  for (const source of cliSources) {
    for (const [, flag = ''] of source.matchAll(pattern)) {
      flags.add(flag);
    }
  }
  return [...flags].toSorted();
}

function doctorCodes(): readonly string[] {
  const codes = new Set<string>();
  for (const source of cliSources) {
    for (const [, code = ''] of source.matchAll(/code: '(PD\d{3})'/gu)) {
      codes.add(code);
    }
  }
  return [...codes].toSorted();
}

function packageEntries(): readonly string[] {
  const manifest = JSON.parse(
    read(join(ROOT, 'packages', 'permdock', 'package.json')),
  ) as { readonly exports: Readonly<Record<string, unknown>> };
  return Object.keys(manifest.exports)
    .filter((entry) => entry !== '.' && entry !== './package.json')
    .map((entry) => `permdock/${entry.slice(2)}`);
}

function unlistedPages(): readonly string[] {
  const missing: string[] = [];
  const metas = walk(DOCS, (file) => basename(file) === 'meta.json');
  for (const meta of metas) {
    const dir = dirname(meta);
    const pages = new Set(
      (JSON.parse(read(meta)) as { readonly pages?: readonly string[] })
        .pages ?? [],
    );
    if (pages.has('...')) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      const page = name.endsWith('.mdx')
        ? name.slice(0, -4)
        : statSync(join(dir, name)).isDirectory()
          ? name
          : undefined;
      if (page !== undefined && !pages.has(page)) {
        missing.push(relative(ROOT, join(dir, name)));
      }
    }
  }
  return missing;
}

const problems = [
  ...cliFlags()
    .filter((flag) => !cliDocs.includes(`--${flag}`))
    .map((flag) => `CLI flag --${flag} is not documented under docs/cli`),
  ...doctorCodes()
    .filter((code) => !cliDocs.includes(`| \`${code}\``))
    .map((code) => `doctor ${code} has no row in docs/cli/doctor.mdx`),
  ...packageEntries()
    .filter((entry) => !allDocs.includes(entry))
    .map((entry) => `package entry ${entry} is not mentioned in the docs`),
  ...unlistedPages().map((page) => `${page} is not listed in its meta.json`),
];

if (problems.length > 0) {
  process.stderr.write(`${problems.map((line) => `- ${line}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'docs match the CLI, doctor checks and package entries\n',
  );
}
