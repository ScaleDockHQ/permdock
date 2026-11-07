import type { UserConfig } from "@commitlint/types";

import { RuleConfigSeverity } from "@commitlint/types";

const BOT_HEADER = /^(chore: version packages|chore\(deps(?:-dev)?\):|Merge )/u;

const config = {
  extends: ["@commitlint/config-conventional"],
  ignores: [
    (message: string): boolean =>
      BOT_HEADER.test(message.split("\n", 1)[0] ?? ""),
  ],
  rules: {
    "type-enum": [
      RuleConfigSeverity.Error,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "chore",
        "ci",
        "refactor",
        "test",
        "perf",
        "style",
        "build",
        "revert",
      ],
    ],
    "subject-case": [
      RuleConfigSeverity.Error,
      "never",
      ["pascal-case", "start-case", "upper-case"],
    ],
    "header-max-length": [RuleConfigSeverity.Disabled],
  },
} satisfies UserConfig;

export default config;
