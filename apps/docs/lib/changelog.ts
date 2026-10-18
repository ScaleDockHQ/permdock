import type { TOCItemType } from "fumadocs-core/toc";

// The bundler compiles the root changelog into the build. A path resolved at
// runtime from `import.meta.url` points into `.next/server` and finds nothing,
// and a content collection rooted at the repository watches every workspace.
// `content/changelog.md` is a symlink to it: `turbo boundaries` rejects an
// import that leaves the package, and the build task hashes the real file.
import ChangelogMarkdown, { toc } from "../content/changelog.md";
import { docsRoute } from "./shared";

export const changelogRoute = `${docsRoute}/changelog`;

export const ChangelogBody = ChangelogMarkdown;

/** The release headings; the file's own H1 repeats the page title. */
export const changelogToc: TOCItemType[] = toc.filter((item) => item.depth > 1);
