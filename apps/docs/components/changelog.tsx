import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";

import { getMDXComponents } from "@/components/mdx";
import { ChangelogBody, changelogToc } from "@/lib/changelog";

export function Changelog() {
  return (
    <DocsPage toc={changelogToc}>
      <DocsTitle>Changelog</DocsTitle>
      <DocsDescription>Every PermDock release, newest first.</DocsDescription>
      <DocsBody className="[&>h1:first-child]:hidden">
        <ChangelogBody components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}
