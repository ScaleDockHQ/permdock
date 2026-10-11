"use client";

import { useRouter } from "fumadocs-core/framework";
import { fetchClient } from "fumadocs-core/search/client/fetch";
import { useEffect } from "react";

import { docsContentRoute, docsRoute } from "@/lib/shared";

type ModelContextTool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: unknown) => unknown;
};

declare global {
  interface Document {
    /** WebMCP, see https://webmachinelearning.github.io/webmcp/ */
    modelContext?: {
      registerTool: (
        tool: ModelContextTool,
        options?: { signal?: AbortSignal },
      ) => Promise<void> | void;
    };
  }
}

const urlInput = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "A docs URL or path, e.g. /docs/adapters/hono",
    },
  },
  required: ["url"],
} as const;

function stringField(input: unknown, key: string): string {
  if (typeof input === "object" && input !== null && key in input) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value === "string") return value;
  }
  throw new Error(`${key} must be a string`);
}

/** The docs path of a model-supplied URL; anything off this origin or outside `/docs` throws. */
function docsPath(input: unknown): string {
  const raw = stringField(input, "url");
  const url = new URL(raw, window.location.origin);
  const path = url.pathname.replace(/\.md$/u, "").replace(/\/$/u, "");
  if (
    url.origin !== window.location.origin ||
    (path !== docsRoute && !path.startsWith(`${docsRoute}/`))
  ) {
    throw new Error(`not a docs page: ${raw}`);
  }
  return path;
}

function markdownUrl(path: string): string {
  const slugs = path.slice(docsRoute.length);
  return `${docsContentRoute}${slugs}/content.md`;
}

/** Registers `search_docs`, `read_page` and `open_page` with the browser's agent. */
export function WebMCP() {
  const router = useRouter();

  useEffect(() => {
    const context = document.modelContext;
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const client = fetchClient();

    void context?.registerTool(
      {
        name: "search_docs",
        description:
          "Search the PermDock docs; returns matching pages and headings with their URLs.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
        execute: (input) => client.search(stringField(input, "query")),
      },
      options,
    );
    void context?.registerTool(
      {
        name: "read_page",
        description: "Read a PermDock docs page as Markdown by its URL.",
        inputSchema: urlInput,
        annotations: { readOnlyHint: true },
        async execute(input) {
          const path = docsPath(input);
          const res = await fetch(markdownUrl(path));
          if (!res.ok) throw new Error(`page not found: ${path}`);
          return res.text();
        },
      },
      options,
    );
    void context?.registerTool(
      {
        name: "open_page",
        description: "Navigate the browser to a PermDock docs page by its URL.",
        inputSchema: urlInput,
        async execute(input) {
          const path = docsPath(input);
          await router.push(path);
          return `opened ${path}`;
        },
      },
      options,
    );

    return () => controller.abort();
  }, [router]);

  return null;
}
