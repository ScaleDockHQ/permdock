import { fileURLToPath } from 'node:url';
import { type OxlintConfig, defineConfig } from 'oxlint';

/**
 * Build output and caches that no workspace should lint.
 *
 * `extends` merges `rules`, `plugins` and `overrides`, but a consumer's own
 * `ignorePatterns` replaces the inherited list. Consumers that add ignores
 * must spread this constant in front of their own patterns.
 */
export const ignorePatterns: readonly string[] = [
  '**/{dist,.next,.nuxt,.output,.svelte-kit,.source,coverage,.turbo,node_modules}/**',
];

/**
 * Shared Oxlint baseline for every workspace in the repository.
 *
 * Consumers pass it through `extends`:
 *
 * ```ts
 * import { base, ignorePatterns } from '@permdock/ox-config/oxlint';
 * import { defineConfig } from 'oxlint';
 *
 * export default defineConfig({
 *   extends: [base],
 *   ignorePatterns: [...ignorePatterns, 'generated/**'],
 * });
 * ```
 *
 * The `options.typeAware` switch is deliberately absent: type-aware linting
 * runs once, from the root config, over the whole repository.
 */
export const base: OxlintConfig = defineConfig({
  ignorePatterns: [...ignorePatterns],
  // Oxlint resolves bare and relative specifiers from the consuming config,
  // so both plugins are handed over as absolute paths from this package.
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
    'unicorn',
    'typescript',
    'oxc',
    'import',
    'node',
    'vitest',
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
    // Invariant 10: no eval, no `new Function`.
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'typescript/no-explicit-any': 'error',
    'unicorn/prefer-module': 'error',
    // Node 24 and ES2024 targets: native syntax, never down-levelled.
    'oxc/no-async-await': 'off',
    // Node 24 and ES2024 targets: native syntax, never down-levelled.
    'oxc/no-optional-chaining': 'off',
    // Node 24 and ES2024 targets: native syntax, never down-levelled.
    'oxc/no-rest-spread-properties': 'off',
    // turbo.json runs in strict env mode; undeclared variables are cache bugs.
    'turbo/no-undeclared-env-vars': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    // UI adapters' Proxy get traps forward reads with the receiver-preserving Reflect.get.
    'anti-slop/no-reflect-get': 'off',
    // Boundary validation (invariant 9) narrows untrusted JSON with `typeof`.
    'anti-slop/no-runtime-typeof': 'off',
    // Boundary entry points (refresh, tool args, remote decisions) take `unknown` and validate it.
    'anti-slop/no-unknown-parameters': 'off',
    // Condition paths, claims and adapter hooks hand back `unknown` for the caller to validate.
    'anti-slop/no-unknown-returns': 'off',
    // `Record<string, unknown>` is the JSON boundary type; noUncheckedIndexedAccess guards reads.
    'anti-slop/no-unsafe-dictionary-type': 'off',
    // exactOptionalPropertyTypes forbids `key: undefined`; the conditional spread omits the key.
    'anti-slop/no-conditional-empty-object-spread': 'off',
    // Explicit return and wire types (isolatedDeclarations on exports) are the contract by design.
    'anti-slop/no-known-value-widening': 'off',
    // `as unknown as` erases the TUser / listener generics at the policy boundary.
    'anti-slop/no-chained-type-assertions': 'off',
    // `object` is the non-primitive bound for prototype-safe reads and foreign tables / contexts.
    'anti-slop/no-object-parameters': 'off',
    // "Shape" is Standard Schema, tRPC and SQL vocabulary here, including public type parameters.
    'anti-slop/no-shape-in-symbol-names': 'off',
    // Over 1,000 existing assertions; a SAFETY-comment pass needs its own PR.
    'anti-slop/require-safety-comment-for-type-assertion': 'off',
    // `Record<never, never>` is the deliberate empty context in adapter and middleware generics.
    'typescript/no-generated-empty-object-type': 'off',
    // Config files (`*.config.ts`) need a default export; publishable
    // packages turn this back on via an override in the root config.
    'import/no-default-export': 'off',
  },
  overrides: [
    {
      files: [
        '**/*.{test,spec}.{ts,tsx}',
        '**/tests/**/*.{ts,tsx}',
        'tests/**/*.{ts,tsx}',
      ],
      plugins: [
        'eslint',
        'unicorn',
        'typescript',
        'oxc',
        'import',
        'node',
        'vitest',
      ],
    },
  ],
});

/**
 * React, jsx-a11y and Next.js rules for UI apps, applied through an override.
 *
 * Overrides cannot set `categories`, so this lists every rule of the three
 * plugins in the categories `base` enables (correctness, suspicious, perf,
 * restriction, pedantic) as of oxlint 1.86. Re-check it on oxlint upgrades.
 */
export const uiRules: NonNullable<OxlintConfig['rules']> = {
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
  // Tailwind styles components through `className`.
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
  // Its default allows JSX only in `.jsx`; the apps are TSX.
  'react/jsx-filename-extension': 'off',
  'react/jsx-key': 'error',
  'react/jsx-no-comment-textnodes': 'error',
  'react/jsx-no-constructed-context-values': 'error',
  'react/jsx-no-duplicate-props': 'error',
  // Copy lives in JSX; there is no i18n layer.
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
  // Pages keep small private sections next to the component that uses them.
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
  // Next.js route files export `metadata` and config next to the page.
  'react/only-export-components': 'off',
  'react/prefer-function-component': 'error',
  'react/preserve-manual-memoization': 'error',
  'react/purity': 'error',
  // `jsx: react-jsx` uses the automatic runtime.
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
};
