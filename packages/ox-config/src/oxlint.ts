import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type OxlintConfig, defineConfig } from 'oxlint';

type Rules = NonNullable<OxlintConfig['rules']>;

interface TurboGlobal {
  readonly global: {
    readonly env: readonly string[];
    readonly passThroughEnv: readonly string[];
  };
}

/**
 * Build output and caches that no workspace should lint.
 *
 * `extends` merges `rules`, `plugins` and `overrides`, but a consumer's own
 * `ignorePatterns` replaces the inherited list. Consumers that add ignores
 * must spread this constant in front of their own patterns.
 */
export const ignorePatterns: readonly string[] = [
  '**/{dist,.next,.nuxt,.output,.svelte-kit,.source,.expo,coverage,.turbo,node_modules}/**',
];

// Read by servers Playwright or Vitest start and by CI scripts, never by a turbo task.
const runtimeOnlyEnv = [
  'AGENT_USER',
  'API_ORIGIN',
  'HOST',
  'INIT_CWD',
  'MEMBERSHIP_MODE',
  'PERMDOCK_E2E_NO_PRIVATE_CACHE',
  'PG_URI',
  'PORT',
  'RUNNER_TEMP',
  'SESSION_SECRET',
  'SKIP_BUILD',
  'WORKER_TOKEN',
];

// eslint-plugin-turbo reads only the legacy `globalEnv` keys, not the
// `futureFlags.globalConfiguration` block, so it gets turbo.json's lists here.
// SAFETY: turbo.json is the repository's own file and its schema is checked by turbo.
const turbo = JSON.parse(
  readFileSync(new URL('../../../turbo.json', import.meta.url), 'utf8'),
) as TurboGlobal;

const envAllowList = [
  ...turbo.global.env,
  ...turbo.global.passThroughEnv,
  ...runtimeOnlyEnv,
].map((name) => `^${name.replace('*', '.*')}$`);

/**
 * Imports the repository never takes, anywhere: Base UI replaces Radix, and
 * the shadcn Drawer replaces vaul.
 */
const neverImport = {
  paths: [
    { name: 'vaul', message: 'Use the shadcn Drawer from `@permdock/ui`.' },
  ],
  patterns: [
    { group: ['@radix-ui/*'], message: 'Use Base UI (`@base-ui/react`).' },
  ],
};

function banned(
  names: readonly string[],
  message: string,
): { name: string; message: string }[] {
  return names.map((name) => ({ name, message }));
}

/**
 * One library per concern for the docs and marketing apps and the packages
 * they share. The published package, its tests and the examples are exempt:
 * they exercise Zod, ArkType and third-party agent SDKs on purpose.
 */
export const oneLibraryPerConcern: Rules = {
  'eslint/no-restricted-imports': [
    'error',
    {
      paths: [
        ...neverImport.paths,
        ...banned(
          ['zod', 'zod/mini', 'arktype', 'yup', 'joi'],
          'Schemas use Valibot.',
        ),
        ...banned(['moment', 'dayjs', 'luxon'], 'Dates use date-fns.'),
        ...banned(
          [
            'openai',
            '@anthropic-ai/sdk',
            '@google/genai',
            '@google/generative-ai',
            '@ai-sdk/openai',
            '@ai-sdk/anthropic',
            '@ai-sdk/google',
          ],
          'Model calls use the AI SDK (`ai`) through AI Gateway.',
        ),
        ...banned(['react-icons'], 'Icons come from lucide-react.'),
        ...banned(['react-hook-form', 'formik'], 'Forms use TanStack Form.'),
        ...banned(
          ['swr', 'zustand', 'jotai', 'redux', '@reduxjs/toolkit'],
          'Remote data uses RSC or TanStack Query; UI state uses TanStack Store.',
        ),
      ],
      patterns: [
        ...neverImport.patterns,
        {
          group: ['react-icons/*', '@heroicons/*'],
          message: 'Icons come from lucide-react.',
        },
      ],
    },
  ],
};

/**
 * Shared Oxlint baseline for every workspace in the repository.
 *
 * Every workspace's `oxlint.config.ts` extends `core` plus the presets it
 * needs. The categories go beyond correctness and suspicious on purpose;
 * the pinned rules below stay on whatever a category change does.
 */
export const core: OxlintConfig = defineConfig({
  ignorePatterns: [...ignorePatterns],
  options: {
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: 'error',
  },
  // Oxlint resolves bare and relative specifiers from the consuming config,
  // so every plugin is handed over as an absolute path from this package.
  jsPlugins: [
    {
      name: 'anti-slop',
      specifier: fileURLToPath(new URL('anti-slop/index.ts', import.meta.url)),
    },
    {
      name: 'turbo',
      specifier: fileURLToPath(import.meta.resolve('eslint-plugin-turbo')),
    },
  ],
  plugins: [
    'eslint',
    'typescript',
    'oxc',
    'unicorn',
    'import',
    'node',
    'promise',
  ],
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'error',
    restriction: 'error',
    pedantic: 'error',
    style: 'off',
    nursery: 'off',
  },
  rules: {
    'eslint/eqeqeq': 'error',
    'eslint/no-empty': 'error',
    'eslint/no-restricted-imports': ['error', neverImport],
    // Invariant 10: no eval, no `new Function`.
    'eslint/no-eval': 'error',
    'eslint/no-implied-eval': 'error',
    'eslint/no-new-func': 'error',
    'import/no-cycle': 'error',
    'import/no-unassigned-import': 'error',
    'node/no-process-env': 'error',
    // turbo.json runs in strict env mode; undeclared variables are cache bugs.
    'turbo/no-undeclared-env-vars': ['error', { allowList: envAllowList }],
    'typescript/await-thenable': 'error',
    'typescript/consistent-type-imports': 'error',
    'typescript/no-deprecated': 'error',
    'typescript/no-explicit-any': 'error',
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/no-non-null-assertion': 'error',
    'typescript/no-unnecessary-condition': 'error',
    'typescript/no-unsafe-argument': 'error',
    'typescript/no-unsafe-assignment': 'error',
    'typescript/no-unsafe-call': 'error',
    'typescript/no-unsafe-declaration-merging': 'error',
    'typescript/no-unsafe-enum-comparison': 'error',
    'typescript/no-unsafe-function-type': 'error',
    'typescript/no-unsafe-member-access': 'error',
    'typescript/no-unsafe-return': 'error',
    'typescript/no-unsafe-type-assertion': 'error',
    'typescript/no-unsafe-unary-minus': 'error',
    'typescript/only-throw-error': 'error',
    'typescript/prefer-nullish-coalescing': 'error',
    'typescript/prefer-optional-chain': 'error',
    'typescript/return-await': 'error',
    'typescript/strict-boolean-expressions': 'error',
    'typescript/switch-exhaustiveness-check': 'error',
    'typescript/unbound-method': 'error',
    'unicorn/prefer-module': 'error',
    // Node 24 and ES2025 targets: native syntax, never down-levelled (2369 findings).
    'oxc/no-async-await': 'off',
    // Node 24 and ES2025 targets: native syntax, never down-levelled (1802 findings).
    'oxc/no-optional-chaining': 'off',
    // Node 24 and ES2025 targets: native syntax, never down-levelled (826 findings).
    'oxc/no-rest-spread-properties': 'off',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    // `as unknown as` erases the TUser / listener generics at the policy boundary (57 findings).
    'anti-slop/no-chained-type-assertions': 'off',
    // Enabled once every existing assertion carries a SAFETY comment (1133 findings).
    'anti-slop/require-safety-comment-for-type-assertion': 'off',
    // UI adapters' Proxy get traps forward reads with the receiver-preserving Reflect.get (11 findings).
    'anti-slop/no-reflect-get': 'off',
    // Boundary validation (invariant 9) narrows untrusted JSON with `typeof` (1129 findings).
    'anti-slop/no-runtime-typeof': 'off',
    // Boundary entry points (refresh, tool args, remote decisions) take `unknown` and validate it (699 findings).
    'anti-slop/no-unknown-parameters': 'off',
    // Condition paths, claims and adapter hooks hand back `unknown` for the caller to validate (271 findings).
    'anti-slop/no-unknown-returns': 'off',
    // `Record<string, unknown>` is the JSON boundary type; noUncheckedIndexedAccess guards reads (547 findings).
    'anti-slop/no-unsafe-dictionary-type': 'off',
    // exactOptionalPropertyTypes forbids `key: undefined`; the conditional spread omits the key (177 findings).
    'anti-slop/no-conditional-empty-object-spread': 'off',
    // Explicit return and wire types (isolatedDeclarations on exports) are the contract by design (271 findings).
    'anti-slop/no-known-value-widening': 'off',
    // `object` is the non-primitive bound for prototype-safe reads and foreign tables / contexts (20 findings).
    'anti-slop/no-object-parameters': 'off',
    // "Shape" is Standard Schema, tRPC and SQL vocabulary here, including public type parameters (179 findings).
    'anti-slop/no-shape-in-symbol-names': 'off',
    // `Record<never, never>` is the deliberate empty context in adapter and middleware generics (1 finding).
    'typescript/no-generated-empty-object-type': 'off',
    // Config files (`*.config.ts`) need a default export; `library` turns it back on (193 findings).
    'import/no-default-export': 'off',
    // Promise chains in adapters return the chain; `await` would add a microtask (83 findings).
    'promise/prefer-await-to-then': 'off',
    // Callback-style framework hooks (Express, Fastify, Nest) are the adapter contract (14 findings).
    'promise/prefer-await-to-callbacks': 'off',
    // `.then` callbacks that only run a side effect (store writes, UI state) have nothing to return (11 findings).
    'promise/always-return': 'off',
    // Express `next` and resolver continuations are called from promise callbacks by contract (5 findings).
    'promise/no-callback-in-promise': 'off',
    // `.then(onFulfilled, onRejected)` handles rejection, which this rule does not recognise (3 findings).
    'promise/catch-or-return': 'off',
  },
  overrides: [
    {
      files: ['**/*.cjs'],
      rules: {
        // CommonJS files have no import or export (4 findings).
        'import/unambiguous': 'off',
        // These files are CommonJS by extension (10 findings).
        'import/no-commonjs': 'off',
        // CommonJS loads with require() (4 findings).
        'typescript/no-require-imports': 'off',
        // CommonJS loads with require() (4 findings).
        'typescript/no-var-requires': 'off',
        // require() results are untyped (2 findings).
        'typescript/no-unsafe-call': 'off',
        // require() results are untyped (2 findings).
        'typescript/no-unsafe-member-access': 'off',
      },
    },
    {
      files: [
        '**/*.config.ts',
        '**/*.config.mts',
        '**/vitest.config.ts',
        '**/tsdown.config.ts',
        '**/knip.mts',
      ],
      rules: {
        // Tools load the config's default export (120 findings).
        'import/no-default-export': 'off',
      },
    },
  ],
});

/**
 * Published library code: named exports only, and the relaxations that
 * frozen JSON, closures and isolatedDeclarations need.
 */
export const library: OxlintConfig = defineConfig({
  rules: {
    'import/no-default-export': 'error',
    // Same-package folders (core, conditions) import each other (1241 findings).
    'import/no-relative-parent-imports': 'off',
    // exactOptionalPropertyTypes and compact() use `undefined` as the omit sentinel (3738 findings).
    'eslint/no-undefined': 'off',
    // Same sentinel: explicit `undefined` marks an omitted field (115 findings).
    'unicorn/no-useless-undefined': 'off',
    // Modules read top-down from the export; helpers are hoisted below it (263 findings).
    'eslint/no-use-before-define': 'off',
    // Request, Response and framework contexts are never deeply readonly (1531 findings).
    'typescript/prefer-readonly-parameter-types': 'off',
    // Fail-closed guards check untyped runtime input that the static types call impossible (116 findings).
    'typescript/no-unnecessary-condition': 'off',
    // `.map(fn)` with typed callbacks is the house style (76 findings).
    'unicorn/no-array-callback-reference': 'off',
    // createPermDock and adapter factories are closures by design (502 findings).
    'eslint/max-lines-per-function': 'off',
    // Generic trees, frozen JSON and isolatedDeclarations need assertions; each carries a SAFETY comment (652 findings).
    'typescript/no-unsafe-type-assertion': 'off',
    // Assertions pin declaration types that tsgolint infers but tsc 5.9 in the type matrix does not (98 findings).
    'typescript/no-unnecessary-type-assertion': 'off',
    // Single-use type parameters carry inference for public generics (5 findings).
    'typescript/no-unnecessary-type-parameters': 'off',
    // `=== true` keeps fail-closed checks explicit on boolean-ish results (15 findings).
    'typescript/no-unnecessary-boolean-literal-compare': 'off',
    // `String(id)` formats unknown resource ids for audit events (24 findings).
    'typescript/no-base-to-string': 'off',
    // Sources and sinks pass promises through without an extra microtask (249 findings).
    'typescript/promise-function-async': 'off',
    // Core modules (policy, evaluate, instance) keep one concept per file (145 findings).
    'eslint/max-lines': 'off',
    // Evaluation branches mirror the decision table; splitting hides the order (80 findings).
    'eslint/complexity': 'off',
    // Adapter entry files wire many core modules (48 findings).
    'import/max-dependencies': 'off',
    // `void` marks deliberate fire-and-forget sink writes (22 findings).
    'eslint/no-void': 'off',
    // sha256 and constant-time comparison are bitwise by definition (56 findings).
    'eslint/no-bitwise': 'off',
    // `| 0` is 32-bit wraparound in sha256, not truncation (13 findings).
    'unicorn/prefer-math-trunc': 'off',
    // Related error and store classes share one module (6 findings).
    'eslint/max-classes-per-file': 'off',
  },
});

/**
 * Node tooling: repository scripts, test workspaces and fixture servers.
 */
export const node: OxlintConfig = defineConfig({
  rules: {
    // Tests pass `undefined` to probe optional inputs (358 findings).
    'eslint/no-undefined': 'off',
    // Node built-ins are imported by name (57 findings).
    'unicorn/import-style': 'off',
    // `import.meta.url` is the form Bun, Deno and bundlers all support (52 findings).
    'unicorn/prefer-import-meta-properties': 'off',
    // Scripts read untyped JSON and child-process output (7 findings).
    'typescript/no-unsafe-return': 'off',
    // Scripts narrow parsed JSON they wrote themselves (166 findings).
    'typescript/no-unsafe-type-assertion': 'off',
    // Scripts and tests are not a published API (48 findings).
    'typescript/explicit-module-boundary-types': 'off',
    // Scripts and fixtures read CI, port and database settings (39 findings).
    'node/no-process-env': 'off',
    // Fixture apps export defaults for their framework (95 findings).
    'import/no-default-export': 'off',
    // `.map(fn)` with typed callbacks is the house style (26 findings).
    'unicorn/no-array-callback-reference': 'off',
    // Child-process scripts run as ESM, never through require(esm) (22 findings).
    'node/no-top-level-await': 'off',
  },
});

/**
 * Vitest suites. Test-only workspaces extend it for every file; packages
 * apply `test.rules` in an override on their `tests/` folder.
 */
export const test: OxlintConfig = defineConfig({
  plugins: ['vitest'],
  rules: {
    // Test helpers are local; inference is enough (430 findings).
    'typescript/explicit-function-return-type': 'off',
    // Test doubles mutate their inputs on purpose (1142 findings).
    'typescript/prefer-readonly-parameter-types': 'off',
    // Type tests probe the empty context on purpose (1 finding).
    'typescript/no-generated-empty-object-type': 'off',
    // The Vitest config sets the timeout once (1501 findings).
    'vitest/require-test-timeout': 'off',
    // Matrix cases branch on the expected outcome (549 findings).
    'vitest/no-conditional-in-test': 'off',
    // Tests feed impossible values and assert identity across copies on purpose (49 findings).
    'typescript/no-unnecessary-condition': 'off',
    // Matrix cases assert the branch they took (122 findings).
    'vitest/no-conditional-expect': 'off',
    // Runtime-specific cases skip by environment (8 findings).
    'vitest/no-conditional-tests': 'off',
    // Titles are built from matrix rows (6 findings).
    'vitest/valid-title': 'off',
    // Conformance runners assert inside shared helpers (14 findings).
    'vitest/expect-expect': 'off',
    // A describe block groups many cases (350 findings).
    'eslint/max-lines-per-function': 'off',
    // Matrix suites are long by design (71 findings).
    'eslint/max-lines': 'off',
    // Integration tests wire many adapters (30 findings).
    'import/max-dependencies': 'off',
    // Test patterns match ASCII output (132 findings).
    'eslint/require-unicode-regexp': 'off',
    // tsc noUnusedLocals already reports unused bindings (7 findings).
    'eslint/no-unused-vars': 'off',
    // Tests import the module under test from its folder (445 findings).
    'import/no-relative-parent-imports': 'off',
    // Tests pass malformed input to prove fail-closed behaviour (54 findings).
    'typescript/no-unsafe-argument': 'off',
    // Tests read untyped JSON responses (31 findings).
    'typescript/no-unsafe-member-access': 'off',
    // Tests call untyped framework handles (38 findings).
    'typescript/no-unsafe-call': 'off',
    // Tests read untyped JSON responses (46 findings).
    'typescript/no-unsafe-assignment': 'off',
    // Assertions pin literal types in fixtures (48 findings).
    'typescript/no-unnecessary-type-assertion': 'off',
    // Assertions follow an expect that proved the value exists (64 findings).
    'typescript/no-non-null-assertion': 'off',
    // Test doubles return untyped JSON and framework handles (31 findings).
    'typescript/no-unsafe-return': 'off',
    // Async callbacks match the interface under test (161 findings).
    'typescript/require-await': 'off',
    // Async callbacks match the interface under test (214 findings).
    'eslint/require-await': 'off',
    // Test doubles return promises without async (217 findings).
    'typescript/promise-function-async': 'off',
    // Store tests fire writes and assert on the next read (50 findings).
    'typescript/no-floating-promises': 'off',
    // Arrow shorthand returns void calls in callbacks (9 findings).
    'typescript/no-confusing-void-expression': 'off',
    // Template literals keep matrix titles uniform (1 finding).
    'typescript/no-unnecessary-template-expression': 'off',
    // Tests throw plain Error to simulate failing closures and parsers (34 findings).
    'unicorn/prefer-type-error': 'off',
    // `void` marks deliberately ignored promises (15 findings).
    'eslint/no-void': 'off',
    // Ordered steps model sequential requests and pages (158 findings).
    'eslint/no-await-in-loop': 'off',
    // Case-local helpers stay next to the assertions that use them (38 findings).
    'unicorn/consistent-function-scoping': 'off',
    // Test files never import each other, so a focused or skipped case is always a mistake.
    'vitest/no-focused-tests': 'error',
    'vitest/no-disabled-tests': 'error',
  },
});

/**
 * React, jsx-a11y and Next.js rules for UI apps, the React Doctor effect
 * rules, and the shadcn design-system rules.
 *
 * This lists every rule of the react, jsx-a11y and nextjs plugins in the
 * categories `core` enables as of oxlint 1.86. Re-check it on oxlint upgrades.
 */
export const react: OxlintConfig = defineConfig({
  jsPlugins: [
    {
      name: 'react-doctor',
      specifier: fileURLToPath(
        import.meta.resolve('oxlint-plugin-react-doctor'),
      ),
    },
    {
      name: 'shadcn',
      specifier: fileURLToPath(import.meta.resolve('@shadcn/lint')),
    },
  ],
  plugins: ['react', 'jsx-a11y', 'nextjs'],
  rules: {
    'jsx-a11y/alt-text': 'error',
    'jsx-a11y/anchor-ambiguous-text': 'error',
    'jsx-a11y/anchor-has-content': 'error',
    'jsx-a11y/anchor-is-valid': 'error',
    'jsx-a11y/aria-activedescendant-has-tabindex': 'error',
    'jsx-a11y/aria-props': 'error',
    'jsx-a11y/aria-proptypes': 'error',
    'jsx-a11y/aria-role': 'error',
    'jsx-a11y/aria-unsupported-elements': 'error',
    'jsx-a11y/autocomplete-valid': 'error',
    'jsx-a11y/click-events-have-key-events': 'error',
    'jsx-a11y/control-has-associated-label': 'error',
    'jsx-a11y/heading-has-content': 'error',
    'jsx-a11y/html-has-lang': 'error',
    'jsx-a11y/iframe-has-title': 'error',
    'jsx-a11y/img-redundant-alt': 'error',
    'jsx-a11y/interactive-supports-focus': 'error',
    'jsx-a11y/label-has-associated-control': 'error',
    'jsx-a11y/lang': 'error',
    'jsx-a11y/media-has-caption': 'error',
    'jsx-a11y/mouse-events-have-key-events': 'error',
    'jsx-a11y/no-access-key': 'error',
    'jsx-a11y/no-aria-hidden-on-focusable': 'error',
    'jsx-a11y/no-autofocus': 'error',
    'jsx-a11y/no-distracting-elements': 'error',
    'jsx-a11y/no-interactive-element-to-noninteractive-role': 'error',
    'jsx-a11y/no-noninteractive-element-interactions': 'error',
    'jsx-a11y/no-noninteractive-element-to-interactive-role': 'error',
    'jsx-a11y/no-noninteractive-tabindex': 'error',
    'jsx-a11y/no-redundant-roles': 'error',
    'jsx-a11y/no-static-element-interactions': 'error',
    'jsx-a11y/prefer-tag-over-role': 'error',
    'jsx-a11y/role-has-required-aria-props': 'error',
    'jsx-a11y/role-supports-aria-props': 'error',
    'jsx-a11y/scope': 'error',
    'jsx-a11y/tabindex-no-positive': 'error',
    'nextjs/google-font-display': 'error',
    'nextjs/google-font-preconnect': 'error',
    'nextjs/inline-script-id': 'error',
    'nextjs/next-script-for-ga': 'error',
    'nextjs/no-assign-module-variable': 'error',
    'nextjs/no-async-client-component': 'error',
    'nextjs/no-before-interactive-script-outside-document': 'error',
    'nextjs/no-css-tags': 'error',
    'nextjs/no-document-import-in-page': 'error',
    'nextjs/no-duplicate-head': 'error',
    'nextjs/no-head-element': 'error',
    'nextjs/no-head-import-in-document': 'error',
    'nextjs/no-html-link-for-pages': 'error',
    'nextjs/no-img-element': 'error',
    'nextjs/no-page-custom-font': 'error',
    'nextjs/no-script-component-in-head': 'error',
    'nextjs/no-styled-jsx-in-document': 'error',
    'nextjs/no-sync-scripts': 'error',
    'nextjs/no-title-in-document-head': 'error',
    'nextjs/no-typos': 'error',
    'nextjs/no-unwanted-polyfillio': 'error',
    'react/button-has-type': 'error',
    'react/capitalized-calls': 'error',
    'react/checked-requires-onchange-or-readonly': 'error',
    'react/display-name': 'error',
    'react/error-boundaries': 'error',
    'react/exhaustive-deps': 'error',
    'react/exhaustive-effect-dependencies': 'error',
    // Tailwind styles components through `className` (89 findings).
    'react/forbid-component-props': 'off',
    'react/forbid-dom-props': 'error',
    'react/forbid-elements': 'error',
    'react/forward-ref-uses-ref': 'error',
    'react/globals': 'error',
    'react/hooks': 'error',
    'react/iframe-missing-sandbox': 'error',
    'react/immutability': 'error',
    'react/incompatible-library': 'error',
    'react/invariant': 'error',
    // Its default allows JSX only in `.jsx`; the apps are TSX (66 findings).
    'react/jsx-filename-extension': 'off',
    'react/jsx-key': 'error',
    'react/jsx-no-comment-textnodes': 'error',
    'react/jsx-no-constructed-context-values': 'error',
    'react/jsx-no-duplicate-props': 'error',
    // Copy lives in JSX; the docs and marketing sites are English only (133 findings).
    'react/jsx-no-literals': 'off',
    'react/jsx-no-script-url': 'error',
    'react/jsx-no-target-blank': 'error',
    'react/jsx-no-undef': 'error',
    'react/jsx-no-useless-fragment': 'error',
    'react/jsx-props-no-spread-multi': 'error',
    'react/memo-dependencies': 'error',
    'react/no-array-index-key': 'error',
    'react/no-children-prop': 'error',
    'react/no-clone-element': 'error',
    'react/no-danger': 'error',
    'react/no-danger-with-children': 'error',
    'react/no-deriving-state-in-effects': 'error',
    'react/no-did-mount-set-state': 'error',
    'react/no-did-update-set-state': 'error',
    'react/no-direct-mutation-state': 'error',
    'react/no-find-dom-node': 'error',
    'react/no-is-mounted': 'error',
    // Pages keep small private sections next to the component that uses them (33 findings).
    'react/no-multi-comp': 'off',
    'react/no-namespace': 'error',
    'react/no-object-type-as-default-prop': 'error',
    'react/no-react-children': 'error',
    'react/no-render-return-value': 'error',
    'react/no-string-refs': 'error',
    'react/no-this-in-sfc': 'error',
    'react/no-unescaped-entities': 'error',
    'react/no-unknown-property': 'error',
    'react/no-unsafe': 'error',
    'react/no-unstable-nested-components': 'error',
    'react/no-will-update-set-state': 'error',
    // Next.js route files export `metadata` and config next to the page (50 findings).
    'react/only-export-components': 'off',
    'react/prefer-function-component': 'error',
    'react/preserve-manual-memoization': 'error',
    'react/purity': 'error',
    // `jsx: react-jsx` uses the automatic runtime (696 findings).
    'react/react-in-jsx-scope': 'off',
    'react/refs': 'error',
    'react/rule-suppression': 'error',
    'react/rules-of-hooks': 'error',
    'react/set-state-in-effect': 'error',
    'react/set-state-in-render': 'error',
    'react/static-components': 'error',
    'react/style-prop-object': 'error',
    'react/syntax': 'error',
    'react/todo': 'error',
    'react/unsupported-syntax': 'error',
    'react/use-memo': 'error',
    'react/void-dom-elements-no-children': 'error',
    'react/void-use-memo': 'error',
    'react-doctor/effect-listener-cleanup-mismatch': 'error',
    'react-doctor/effect-needs-cleanup': 'error',
    'react-doctor/effect-observer-needs-disconnect': 'error',
    'react-doctor/effect-raf-loop-needs-cancel': 'error',
    'react-doctor/no-adjust-state-on-prop-change': 'error',
    'react-doctor/no-async-effect-callback': 'error',
    'react-doctor/no-cascading-set-state': 'error',
    'react-doctor/no-derived-state-effect': 'error',
    'react-doctor/no-effect-chain': 'error',
    'react-doctor/no-effect-event-handler': 'error',
    'react-doctor/no-effect-event-in-deps': 'error',
    'react-doctor/no-effect-with-fresh-deps': 'error',
    'react-doctor/no-event-trigger-state': 'error',
    'react-doctor/no-fetch-in-effect': 'error',
    'react-doctor/no-initialize-state': 'error',
    'react-doctor/no-mirror-prop-effect': 'error',
    'react-doctor/no-pass-live-state-to-parent': 'error',
    'react-doctor/no-prop-callback-in-effect': 'error',
    'react-doctor/no-reset-all-state-on-prop-change': 'error',
    'react-doctor/no-self-updating-effect': 'error',
    'react-doctor/no-set-state-after-await-in-effect': 'error',
    'react-doctor/prefer-use-effect-event': 'error',
    'shadcn/no-inline-styles': 'error',
    'shadcn/no-raw-colors': 'error',
    // Framework file conventions infer page and layout types (140 findings).
    'typescript/explicit-function-return-type': 'off',
    // Framework file conventions infer page and layout types (91 findings).
    'typescript/explicit-module-boundary-types': 'off',
    // Pages, layouts and configs are default exports (91 findings).
    'import/no-default-export': 'off',
    // Framework props are not deeply readonly (215 findings).
    'typescript/prefer-readonly-parameter-types': 'off',
    // CSS entries and `reflect-metadata` are side-effect imports (4 findings).
    'import/no-unassigned-import': 'off',
    // `.map(fn)` with typed callbacks is the house style (2 findings).
    'unicorn/no-array-callback-reference': 'off',
  },
});

/**
 * Playwright specs and their fixtures.
 */
export const playwright: OxlintConfig = defineConfig({
  jsPlugins: [
    {
      name: 'playwright',
      specifier: fileURLToPath(import.meta.resolve('eslint-plugin-playwright')),
    },
  ],
  rules: {
    'playwright/missing-playwright-await': 'error',
    'playwright/no-focused-test': 'error',
    // A suite may skip itself when its external service is not configured.
    'playwright/no-skipped-test': ['error', { allowConditional: true }],
    'playwright/no-page-pause': 'error',
    'playwright/no-useless-await': 'error',
    'playwright/no-wait-for-timeout': 'error',
    'playwright/no-element-handle': 'error',
    'playwright/no-eval': 'error',
    'playwright/no-force-option': 'error',
    'playwright/no-networkidle': 'error',
    'playwright/no-unsafe-references': 'error',
    'playwright/no-useless-not': 'error',
    'playwright/prefer-web-first-assertions': 'error',
    'playwright/valid-expect': 'error',
    'playwright/valid-title': 'error',
  },
});

/**
 * Adapter example apps under `apps/examples`.
 */
export const example: OxlintConfig = defineConfig({
  rules: {
    // App-router and factory files import across src/ folders (47 findings).
    'import/no-relative-parent-imports': 'off',
    // Vite and Next client entries boot with top-level await (21 findings).
    'node/no-top-level-await': 'off',
    // Adapter factories take Policy (TUser = unknown); typed policies need a cast (6 findings).
    'typescript/no-unsafe-type-assertion': 'off',
    // Example servers read PORT from the environment (25 findings).
    'node/no-process-env': 'off',
  },
});

/**
 * Scenario apps under `tests/e2e/fixtures`, built on several frameworks.
 */
export const fixture: OxlintConfig = defineConfig({
  rules: {
    // Framework route, loader and SFC props are mutable types (196 findings).
    'typescript/prefer-readonly-parameter-types': 'off',
    // Loaders return framework promises directly (38 findings).
    'typescript/promise-function-async': 'off',
    // Framework file conventions infer route types (78 findings).
    'typescript/explicit-function-return-type': 'off',
    // Fixture stores copy rows with spread; clarity over speed (2 findings).
    'oxc/no-map-spread': 'off',
    // Framework APIs take `undefined` for an absent value (145 findings).
    'eslint/no-undefined': 'off',
    // Framework handlers return `undefined` to fall through (10 findings).
    'unicorn/no-useless-undefined': 'off',
    // SFC scripts define helpers below the component (6 findings).
    'eslint/no-use-before-define': 'off',
    // `void` marks deliberately ignored navigation promises (13 findings).
    'eslint/no-void': 'off',
    // Svelte and Vue script blocks can have no import or export (4 findings).
    'import/unambiguous': 'off',
    // Server entries boot with top-level await (11 findings).
    'node/no-top-level-await': 'off',
    // Route folders import shared lib files (64 findings).
    'import/no-relative-parent-imports': 'off',
  },
});
