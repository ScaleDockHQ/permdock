import type { Metadata } from "next";

import { DocsBody, DocsPage } from "fumadocs-ui/layouts/docs/page";
import { notFound } from "next/navigation";

import { getMDXComponents } from "@/components/mdx";
import { loadChangelog } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every PermDock release, newest first.",
};

export default async function Page() {
  "use cache";

  const page = await loadChangelog();
  if (!page) notFound();

  const renderer = await page.data.load();
  const { body, toc } = await renderer.render(getMDXComponents());

  return (
    <DocsPage toc={toc}>
      <DocsBody>{body}</DocsBody>
    </DocsPage>
  );
}
