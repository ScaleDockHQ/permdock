import { type OxfmtConfig, defineConfig } from "oxfmt";

const ignorePatterns: readonly string[] = [
  "**/node_modules/**",
  "**/.turbo/**",
  "**/dist/**",
  "**/.next/**",
  "**/.source/**",
  "**/coverage/**",
];

const tailwindFunctions = ["cn", "cva", "tv"];

export interface TailwindStylesheet {
  /** Globs, rooted at the consuming config file, of the files that use the stylesheet. */
  readonly files: readonly string[];
  /** The Tailwind v4 entry stylesheet, relative to the consuming config file. */
  readonly stylesheet: string;
}

export interface OxfmtOptions {
  /** Extra gitignore-style patterns, rooted at the consuming config file. */
  readonly ignorePatterns?: readonly string[];
  /**
   * Each app's Tailwind stylesheet. Without one, classes sort against the
   * default theme, and theme tokens such as `bg-primary` sort as unknown.
   */
  readonly tailwindStylesheets?: readonly TailwindStylesheet[];
}

/**
 * Shared Oxfmt configuration for every workspace in the repository.
 *
 * Oxfmt has no `extends`, so this is a factory. Formatting options are fixed
 * on purpose: only the ignore list and the Tailwind stylesheets vary.
 *
 * ```ts
 * import { oxfmt } from "@permdock/ox-config/oxfmt";
 *
 * export default oxfmt({ ignorePatterns: ["generated/**"] });
 * ```
 */
export function oxfmt(options: OxfmtOptions = {}): OxfmtConfig {
  return defineConfig({
    printWidth: 80,
    semi: true,
    trailingComma: "all",
    ignorePatterns: [...ignorePatterns, ...(options.ignorePatterns ?? [])],
    sortImports: {
      internalPattern: ["@/", "@permdock/"],
      groups: [
        "type-import",
        ["value-builtin", "value-external"],
        "type-internal",
        "value-internal",
        ["type-parent", "type-sibling", "type-index"],
        ["value-parent", "value-sibling", "value-index"],
        "unknown",
      ],
    },
    sortPackageJson: {
      sortScripts: true,
    },
    sortTailwindcss: {
      functions: tailwindFunctions,
    },
    overrides: (options.tailwindStylesheets ?? []).map(
      ({ files, stylesheet }) => ({
        files: [...files],
        options: {
          sortTailwindcss: { functions: tailwindFunctions, stylesheet },
        },
      }),
    ),
  });
}
