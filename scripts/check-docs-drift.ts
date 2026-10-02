import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'apps', 'docs', 'content', 'docs');
const CLI_SRC = join(ROOT, 'packages', 'permdock', 'src', 'cli');
const STANDARDS_TESTS = join(
  ROOT,
  'packages',
  'permdock',
  'tests',
  'standards',
);
/** Standards pages that describe no standard of their own to conform to. */
const UNTESTED_STANDARDS = new Set(['index', 'watch-list']);

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
  // SAFETY: packages/permdock/package.json is the repository's own manifest
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
      // SAFETY: Fumadocs meta.json files carry an optional `pages` string array
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

/** Each standards page has `tests/standards/<slug>.test.ts`, and each such test a page. */
function standardsTests(): readonly string[] {
  const pages = readdirSync(join(DOCS, 'standards'))
    .filter((name) => name.endsWith('.mdx'))
    .map((name) => name.slice(0, -4))
    .filter((slug) => !UNTESTED_STANDARDS.has(slug));
  const tests = readdirSync(STANDARDS_TESTS)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => name.slice(0, -'.test.ts'.length));
  return [
    ...pages
      .filter((slug) => !tests.includes(slug))
      .map(
        (slug) =>
          `docs/standards/${slug}.mdx has no packages/permdock/tests/standards/${slug}.test.ts`,
      ),
    ...tests
      .filter((slug) => !pages.includes(slug))
      .map(
        (slug) =>
          `packages/permdock/tests/standards/${slug}.test.ts has no docs/standards/${slug}.mdx`,
      ),
  ];
}

const problems = [
  ...doctorCodes()
    .filter((code) => !cliDocs.includes(`| \`${code}\``))
    .map((code) => `doctor ${code} has no row in docs/cli/doctor.mdx`),
  ...packageEntries()
    .filter((entry) => !allDocs.includes(entry))
    .map((entry) => `package entry ${entry} is not mentioned in the docs`),
  ...unlistedPages().map((page) => `${page} is not listed in its meta.json`),
  ...standardsTests(),
];

if (problems.length > 0) {
  process.stderr.write(`${problems.map((line) => `- ${line}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'docs match the doctor checks, package entries and standards tests\n',
  );
}
