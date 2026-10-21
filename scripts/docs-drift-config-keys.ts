import { readFileSync } from "node:fs";
import { join } from "node:path";

// oxlint-disable-next-line import/no-relative-parent-imports -- Node strips the types, so the drift check reads the config registry without a build
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
  const shape: Readonly<Record<string, object>> = CONFIG_SHAPE;
  const drift: string[] = [];
  for (const [section, keys] of Object.entries(shape)) {
    for (const key of Object.keys(keys)) {
      if (!page.includes(`| \`${section}.${key}\``)) {
        drift.push(
          `config key ${section}.${key} has no row in docs/cli/config.mdx`,
        );
      }
    }
  }
  return drift;
}
