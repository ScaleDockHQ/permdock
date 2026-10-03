import { localMd } from "@fumadocs/local-md";
import { loader } from "fumadocs-core/source";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

import { docsRoute } from "./shared";

export const changelogRoute = `${docsRoute}/changelog`;

const changelogMd = localMd({
  dir: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  include: ["CHANGELOG.md"],
  frontmatterSchema: v.object({
    title: v.optional(v.string(), "Changelog"),
    description: v.optional(v.string()),
  }),
});

export async function loadChangelog() {
  const source = loader({
    baseUrl: docsRoute,
    source: await changelogMd.staticSource(),
  });
  return source.getPages().at(0);
}
