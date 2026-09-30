import { base, ignorePatterns, uiRules } from '@permdock/ox-config/oxlint';
import { defineConfig } from 'oxlint';

import turbo from './turbo.json' with { type: 'json' };

// Read by servers and scripts that Playwright or Vitest start, never by a turbo task.
const runtimeOnlyEnv = [
  'AGENT_USER',
  'API_ORIGIN',
  'HOST',
  'INIT_CWD',
  'MEMBERSHIP_MODE',
  'PERMDOCK_E2E_NO_PRIVATE_CACHE',
  'PG_URI',
  'PORT',
  'SESSION_SECRET',
  'SKIP_BUILD',
  'WORKER_TOKEN',
];

// eslint-plugin-turbo reads only the legacy `globalEnv` keys, not the
// `futureFlags.globalConfiguration` block, so it gets turbo.json's lists here.
const envAllowList = [
  ...turbo.global.env,
  ...turbo.global.passThroughEnv,
  ...runtimeOnlyEnv,
].map((name) => `^${name}$`);

export default defineConfig({
  extends: [base],
  ignorePatterns: [
    ...ignorePatterns,
    // Vendored from CentraKit; its RuleTester suites cover it.
    'packages/ox-config/src/anti-slop/**',
    '.agents/**',
    '.cursor/**',
    '.claude/**',
    '**/.expo/**',
    'apps/marketing/components/ui/**',
    'apps/marketing/components/reui/**',
    'apps/marketing/components/blocks/**',
    'tests/integration/src/support/prisma/**',
    'apps/examples/prisma/src/generated/**',
    'tests/e2e/fixtures/*/build/**',
    '**/routeTree.gen.ts',
  ],
  options: {
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: 'error',
  },
  rules: {
    'turbo/no-undeclared-env-vars': ['error', { allowList: envAllowList }],
  },
  overrides: [
    {
      files: ['packages/**/*.{ts,tsx,mts,cts}'],
      rules: {
        'import/no-default-export': 'error',
        // Same-package folders (core, conditions) import each other.
        'import/no-relative-parent-imports': 'off',
        // exactOptionalPropertyTypes and compact() use `undefined` as the omit sentinel.
        'eslint/no-undefined': 'off',
        // Same sentinel: explicit `undefined` marks an omitted field.
        'unicorn/no-useless-undefined': 'off',
        // Modules read top-down from the export; helpers are hoisted below it.
        'eslint/no-use-before-define': 'off',
        // Request, Response and framework contexts are never deeply readonly.
        'typescript/prefer-readonly-parameter-types': 'off',
        // `.map(fn)` with typed callbacks is the house style.
        'unicorn/no-array-callback-reference': 'off',
        // createPermDock and adapter factories are closures by design.
        'eslint/max-lines-per-function': 'off',
        // Generic trees, frozen JSON and isolatedDeclarations need assertions.
        'typescript/no-unsafe-type-assertion': 'off',
        // Assertions pin declaration types that tsgolint infers but tsc 5.9 in the type matrix does not.
        'typescript/no-unnecessary-type-assertion': 'off',
        // Single-use type parameters carry inference for public generics.
        'typescript/no-unnecessary-type-parameters': 'off',
        // `=== true` keeps fail-closed checks explicit on boolean-ish results.
        'typescript/no-unnecessary-boolean-literal-compare': 'off',
        // `String(id)` formats unknown resource ids for audit events.
        'typescript/no-base-to-string': 'off',
        // Sources and sinks pass promises through without an extra microtask.
        'typescript/promise-function-async': 'off',
        // Core modules (policy, evaluate, instance) keep one concept per file.
        'eslint/max-lines': 'off',
        // Evaluation branches mirror the decision table; splitting hides the order.
        'eslint/complexity': 'off',
        // Adapter entry files wire many core modules.
        'import/max-dependencies': 'off',
        // `void` marks deliberate fire-and-forget sink writes.
        'eslint/no-void': 'off',
        // sha256 and constant-time comparison are bitwise by definition.
        'eslint/no-bitwise': 'off',
        // `| 0` is 32-bit wraparound in sha256, not truncation.
        'unicorn/prefer-math-trunc': 'off',
        // Related error and store classes share one module.
        'eslint/max-classes-per-file': 'off',
      },
    },
    {
      files: ['packages/permdock/src/**/*.{ts,tsx}'],
      rules: {
        'typescript/no-generated-empty-object-type': 'error',
      },
    },
    {
      files: ['**/*.cjs'],
      rules: {
        // CommonJS files have no import or export.
        'import/unambiguous': 'off',
        // These files are CommonJS by extension.
        'import/no-commonjs': 'off',
        // CommonJS loads with require().
        'typescript/no-require-imports': 'off',
        // CommonJS loads with require().
        'typescript/no-var-requires': 'off',
        // require() results are untyped.
        'typescript/no-unsafe-call': 'off',
        // require() results are untyped.
        'typescript/no-unsafe-member-access': 'off',
      },
    },
    {
      files: [
        '**/*.config.ts',
        '**/*.config.mts',
        '**/vitest.config.ts',
        '**/tsdown.config.ts',
      ],
      rules: {
        // Tools load the config's default export.
        'import/no-default-export': 'off',
        // One config file lists every override in one place.
        'eslint/max-lines': 'off',
      },
    },
    {
      files: [
        '**/*.{test,spec}.{ts,tsx}',
        '**/*.test-d.ts',
        '**/fixtures/**/*.ts',
        'packages/permdock/src/testing/**/*.ts',
        'tests/**/support/**/*.ts',
        'tests/e2e/src/**/*.ts',
        'tests/e2e/playwright.config.ts',
        'tests/runtimes/src/**/*.ts',
      ],
      rules: {
        // Test helpers are local; inference is enough.
        'typescript/explicit-function-return-type': 'off',
        // Test doubles mutate their inputs on purpose.
        'typescript/prefer-readonly-parameter-types': 'off',
        // Type tests probe the empty context on purpose.
        'typescript/no-generated-empty-object-type': 'off',
        // The Vitest config sets the timeout once.
        'vitest/require-test-timeout': 'off',
        // Matrix cases branch on the expected outcome.
        'vitest/no-conditional-in-test': 'off',
        // Matrix cases assert the branch they took.
        'vitest/no-conditional-expect': 'off',
        // Runtime-specific cases skip by environment.
        'vitest/no-conditional-tests': 'off',
        // Titles are built from matrix rows.
        'vitest/valid-title': 'off',
        // Conformance runners assert inside shared helpers.
        'vitest/expect-expect': 'off',
        // A describe block groups many cases.
        'eslint/max-lines-per-function': 'off',
        // Matrix suites are long by design.
        'eslint/max-lines': 'off',
        // Integration tests wire many adapters.
        'import/max-dependencies': 'off',
        // Test patterns match ASCII output.
        'eslint/require-unicode-regexp': 'off',
        // tsc noUnusedLocals already reports unused bindings.
        'eslint/no-unused-vars': 'off',
        // Tests import the module under test from its folder.
        'import/no-relative-parent-imports': 'off',
        // Tests pass malformed input to prove fail-closed behaviour.
        'typescript/no-unsafe-argument': 'off',
        // Tests read untyped JSON responses.
        'typescript/no-unsafe-member-access': 'off',
        // Tests call untyped framework handles.
        'typescript/no-unsafe-call': 'off',
        // Tests read untyped JSON responses.
        'typescript/no-unsafe-assignment': 'off',
        // Assertions pin literal types in fixtures.
        'typescript/no-unnecessary-type-assertion': 'off',
        // Assertions follow an expect that proved the value exists.
        'typescript/no-non-null-assertion': 'off',
        // Test doubles return untyped JSON and framework handles.
        'typescript/no-unsafe-return': 'off',
        // Async callbacks match the interface under test.
        'typescript/require-await': 'off',
        // Async callbacks match the interface under test.
        'eslint/require-await': 'off',
        // Test doubles return promises without async.
        'typescript/promise-function-async': 'off',
        // Store tests fire writes and assert on the next read.
        'typescript/no-floating-promises': 'off',
        // Arrow shorthand returns void calls in callbacks.
        'typescript/no-confusing-void-expression': 'off',
        // Template literals keep matrix titles uniform.
        'typescript/no-unnecessary-template-expression': 'off',
        // Tests throw plain Error to simulate failing closures and parsers.
        'unicorn/prefer-type-error': 'off',
        // `void` marks deliberately ignored promises.
        'eslint/no-void': 'off',
        // Ordered steps model sequential requests and pages.
        'eslint/no-await-in-loop': 'off',
        // Case-local helpers stay next to the assertions that use them.
        'unicorn/consistent-function-scoping': 'off',
      },
    },
    {
      files: ['tests/**/*.{ts,tsx}', 'scripts/**/*.ts'],
      rules: {
        // Tests pass `undefined` to probe optional inputs.
        'eslint/no-undefined': 'off',
        // Node built-ins are imported by name.
        'unicorn/import-style': 'off',
        // `import.meta.url` is the form Bun, Deno and bundlers all support.
        'unicorn/prefer-import-meta-properties': 'off',
        // Scripts read untyped JSON and child-process output.
        'typescript/no-unsafe-return': 'off',
        // Scripts narrow parsed JSON they wrote themselves.
        'typescript/no-unsafe-type-assertion': 'off',
        // Scripts and tests are not a published API.
        'typescript/explicit-module-boundary-types': 'off',
        // Scripts and fixtures read CI, port and database settings.
        'node/no-process-env': 'off',
        // Fixture apps export defaults for their framework.
        'import/no-default-export': 'off',
        // `.map(fn)` with typed callbacks is the house style.
        'unicorn/no-array-callback-reference': 'off',
        // Child-process scripts run as ESM, never through require(esm).
        'node/no-top-level-await': 'off',
      },
    },
    {
      files: [
        'packages/permdock/src/cli/**/*.{ts,tsx}',
        'packages/permdock/src/unplugin/**/*.ts',
      ],
      rules: {
        // Commands process files in order for stable output.
        'eslint/no-await-in-loop': 'off',
        // Patterns match SQL and TypeScript source text.
        'eslint/require-unicode-regexp': 'off',
        // Guard clauses read `if (!flag)` first.
        'eslint/no-negated-condition': 'off',
        // Guard clauses read `if (!flag)` first.
        'unicorn/no-negated-condition': 'off',
        // pgsql-parser and oxc-parser ASTs arrive untyped.
        'typescript/no-unsafe-assignment': 'off',
        // Optional flags and AST fields are checked for presence.
        'typescript/strict-boolean-expressions': 'off',
        // SQL templates keep identifiers aligned.
        'typescript/no-unnecessary-template-expression': 'off',
        // Regex `.test` keeps SQL token matching uniform.
        'typescript/prefer-includes': 'off',
        // CLI internals are not a published API.
        'typescript/explicit-function-return-type': 'off',
        // Node built-ins are imported by name.
        'unicorn/import-style': 'off',
        // `import.meta.url` survives tsdown bundling of the bin.
        'unicorn/prefer-import-meta-properties': 'off',
        // Generated SQL is built one push per statement.
        'unicorn/prefer-single-call': 'off',
        // Generated SQL is built one push per statement.
        'unicorn/no-immediate-mutation': 'off',
        // Lexers index UTF-16 code units to match parser offsets.
        'unicorn/prefer-code-point': 'off',
        // Global regexes with capture groups use `replace`.
        'unicorn/prefer-string-replace-all': 'off',
        // The bin entry awaits at top level.
        'node/no-top-level-await': 'off',
        // Commands read PERMDOCK_COLLECT and injected env from the environment.
        'node/no-process-env': 'off',
      },
    },
    {
      files: [
        'packages/permdock/src/terminal/**/*.{ts,tsx}',
        'apps/examples/terminal/**/*.{ts,tsx}',
      ],
      rules: {
        // Token and storage lookups default to `process.env`.
        'node/no-process-env': 'off',
        // exit.ts is the one place a consumer CLI sets its status.
        'unicorn/no-process-exit': 'off',
        // Token lookup tries refresh, CI OIDC and device flow in order.
        'eslint/no-await-in-loop': 'off',
        // Token lookup nests source, refresh and retry checks.
        'eslint/max-depth': 'off',
      },
    },
    {
      files: [
        'packages/permdock/src/nest/**/*.{ts,tsx}',
        'apps/examples/nest/**/*.{ts,tsx}',
        'tests/integration/src/http/nest.test.ts',
      ],
      rules: {
        // Nest guards and controllers are classes by framework contract.
        'eslint/class-methods-use-this': 'off',
        // Nest modules are empty decorated classes.
        'typescript/no-extraneous-class': 'off',
        // A Nest module sits next to its controller and guard.
        'eslint/max-classes-per-file': 'off',
        // Nest needs the side-effect `reflect-metadata` import.
        'import/no-unassigned-import': 'off',
        // Nest controllers follow the framework's own style.
        'typescript/explicit-member-accessibility': 'off',
      },
    },
    {
      files: ['apps/examples/**/*.{ts,tsx}'],
      rules: {
        // App-router and factory files import across src/ folders.
        'import/no-relative-parent-imports': 'off',
        // Vite and Next client entries boot with top-level await.
        'node/no-top-level-await': 'off',
        // Adapter factories take Policy (TUser = unknown); typed policies need a cast.
        'typescript/no-unsafe-type-assertion': 'off',
        // Example servers read PORT from the environment.
        'node/no-process-env': 'off',
      },
    },
    {
      files: ['apps/marketing/**/*.{ts,tsx}'],
      rules: {
        // next.config reads DOCS_ORIGIN and NODE_ENV.
        'node/no-process-env': 'off',
        // Long-form pages keep their copy in one file.
        'eslint/max-lines': 'off',
        // Page components hold the page's JSX.
        'eslint/max-lines-per-function': 'off',
        // Pages compose many section components.
        'import/max-dependencies': 'off',
        // Changelog parsing compares optional regex groups with `undefined`.
        'eslint/no-undefined': 'off',
        // Node built-ins are imported by name.
        'unicorn/import-style': 'off',
        // Loaders resolve repo paths from `import.meta.url`, which Next.js bundling rewrites.
        'unicorn/prefer-import-meta-properties': 'off',
        // Changelog and count loaders narrow regex groups and parsed JSON.
        'typescript/no-unsafe-type-assertion': 'off',
        // Handlers and timers wrap void calls in arrow shorthand.
        'typescript/no-confusing-void-expression': 'off',
        // JSX renders optional strings behind a truthiness check.
        'typescript/strict-boolean-expressions': 'off',
        // The copy button takes an async click handler.
        'typescript/no-misused-promises': 'off',
        // The copy button takes an async click handler.
        'typescript/strict-void-return': 'off',
        // Effects return a cleanup only when they start a timer.
        'typescript/consistent-return': 'off',
      },
    },
    {
      files: ['tests/e2e/fixtures/**/*.{ts,tsx,svelte,vue}'],
      rules: {
        // Framework route, loader and SFC props are mutable types.
        'typescript/prefer-readonly-parameter-types': 'off',
        // Loaders return framework promises directly.
        'typescript/promise-function-async': 'off',
        // Framework file conventions infer route types.
        'typescript/explicit-function-return-type': 'off',
        // Fixture stores copy rows with spread; clarity over speed.
        'oxc/no-map-spread': 'off',
        // Framework APIs take `undefined` for an absent value.
        'eslint/no-undefined': 'off',
        // Framework handlers return `undefined` to fall through.
        'unicorn/no-useless-undefined': 'off',
        // SFC scripts define helpers below the component.
        'eslint/no-use-before-define': 'off',
        // `void` marks deliberately ignored navigation promises.
        'eslint/no-void': 'off',
        // Svelte and Vue script blocks can have no import or export.
        'import/unambiguous': 'off',
        // Server entries boot with top-level await.
        'node/no-top-level-await': 'off',
        // Route folders import shared lib files.
        'import/no-relative-parent-imports': 'off',
      },
    },
    {
      files: ['apps/**/*.{ts,tsx,mts,cts}'],
      plugins: [...(base.plugins ?? []), 'react', 'jsx-a11y', 'nextjs'],
      rules: {
        ...uiRules,
        // Framework file conventions infer page and layout types.
        'typescript/explicit-function-return-type': 'off',
        // Framework file conventions infer page and layout types.
        'typescript/explicit-module-boundary-types': 'off',
        // Pages, layouts and configs are default exports.
        'import/no-default-export': 'off',
        // Framework props are not deeply readonly.
        'typescript/prefer-readonly-parameter-types': 'off',
        // CSS entries and `reflect-metadata` are side-effect imports.
        'import/no-unassigned-import': 'off',
        // `.map(fn)` with typed callbacks is the house style.
        'unicorn/no-array-callback-reference': 'off',
      },
    },
  ],
});
