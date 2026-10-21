import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONFIG_SHAPE } from "../packages/permdock/src/cli/project/config-shape.ts";

/**
 * Each key the config registry knows has a `section.key` row on
 * `cli/config.mdx`.
 */
export function configKeyDrift(root: string): readonly string[] {
  const page = readFileSync(
    join(root, "apps", "docs", "content", "docs", "cli", "config.mdx"),
    "utf8",
  );
  return Object.entries(CONFIG_SHAPE).flatMap(([section, keys]) =>
    Object.keys(keys)
      .filter((key) => !page.includes(`| \`${section}.${key}\``))
      .map(
        (key) =>
          `config key ${section}.${key} has no row in docs/cli/config.mdx`,
      ),
  );
}
