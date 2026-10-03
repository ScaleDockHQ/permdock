import { globSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

const EXPORTS = join(ROOT, 'tests', 'bundle', 'src', 'exports.json');
/** The page that lists the old names on purpose. */
const NAMING_PAGE = join(DOCS, 'getting-started', 'naming.mdx');

function walk(dir: string, keep: (file: string) => boolean): string[] {
  return globSync('**/*', { cwd: dir })
    .map((file) => join(dir, file))
    .filter((file) => statSync(file).isFile() && keep(file))
    .toSorted();
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
const docPages = walk(DOCS, (file) => file.endsWith('.mdx'));
const allDocs = docPages.map(read).join('\n');

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

/** Instance names and identifiers renamed before 0.1.0; see the Naming page. */
const BANNED: readonly (readonly [RegExp, string])[] = [
  [
    /\b(?:const|let)\s+(?:dock|pd|factory)\b/u,
    'an instance named dock, pd or factory',
  ],
  [
    /\b(?:dock|pd)\.(?:can|decide|assert|explain|filter|where|snapshot|simulate)\(/u,
    'an instance named dock or pd',
  ],
  [
    /\bconst\s+server\s*=\s*(?:await\s+)?createPermDock\(/u,
    'an instance named server',
  ],
  [
    /\b(?:CreatePermDockOptions|CreatePermDockPluginOptions|SsfAdapter|SsfOptions|SupabaseMiddlewareOptions)\b/u,
    'a renamed type',
  ],
  [/\bA2A[A-Z][a-z]\w*/u, 'an A2A* type (now A2a*)'],
  [/\bkernel\.handler\(/u, 'kernel.handler (now permdockHandler)'],
];

function bannedNames(): readonly string[] {
  const found: string[] = [];
  for (const page of docPages) {
    if (page === NAMING_PAGE) {
      continue;
    }
    const lines = read(page).split('\n');
    for (const [index, line] of lines.entries()) {
      for (const [pattern, what] of BANNED) {
        if (pattern.test(line)) {
          found.push(`${relative(ROOT, page)}:${index + 1} uses ${what}`);
        }
      }
    }
  }
  return found;
}

/** Value imports from a `permdock` entry in docs code that the entry does not export. */
function unknownImports(): readonly string[] {
  // SAFETY: exports.json is the bundle test's own baseline, entry to sorted runtime export names
  const exported = JSON.parse(read(EXPORTS)) as Readonly<
    Record<string, readonly string[]>
  >;
  const found = new Set<string>();
  const importPattern =
    /import\s+\{([^}]*)\}\s+from\s+'(permdock(?:\/[\w/-]+)?)'/gu;
  for (const page of docPages) {
    for (const [, names = '', specifier = ''] of read(page).matchAll(
      importPattern,
    )) {
      const entry =
        specifier === 'permdock'
          ? '.'
          : `./${specifier.slice('permdock/'.length)}`;
      const known = exported[entry];
      if (known === undefined) {
        continue;
      }
      for (const raw of names.split(',')) {
        const name = raw.trim().split(/\s+as\s+/u)[0] ?? '';
        if (name === '' || name.startsWith('type ') || known.includes(name)) {
          continue;
        }
        found.add(
          `${relative(ROOT, page)} imports ${name} from ${specifier}, which does not export it`,
        );
      }
    }
  }
  return [...found];
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
  ...bannedNames(),
  ...unknownImports(),
];

if (problems.length > 0) {
  process.stderr.write(`${problems.map((line) => `- ${line}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    'docs match the doctor checks, package entries, standards tests, names and exports\n',
  );
}
