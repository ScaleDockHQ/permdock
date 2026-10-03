import type { Metadata } from "next";

import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";

import { AskAi } from "@/components/ask-ai";

const title = "Ask AI";
const description =
  "Ask a question about PermDock. The answer comes from these docs and links the pages it used.";

export const metadata: Metadata = { title, description };

export default function Page() {
  return (
    <DocsPage full>
      <DocsTitle>{title}</DocsTitle>
      <DocsDescription>{description}</DocsDescription>
      <DocsBody>
        <AskAi />
      </DocsBody>
    </DocsPage>
  );
}
