import { checkRateLimit } from "@vercel/firewall";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  tool,
} from "ai";
import { checkBotId } from "botid/server";

import { env } from "@/env";
import {
  askAiProblem,
  askAiRateLimitId,
  guardAskAi,
  pageInput,
  parseChatRequest,
  searchInput,
  type AskAiChecks,
} from "@/lib/ask-ai";
import { docsTools } from "@/lib/docs-tools";

const model = "anthropic/claude-sonnet-5.5";
const searchLimit = 8;
const docs = docsTools();

const instructions = `You answer questions about PermDock, a TypeScript authorization library, using only its documentation.
Call search_docs to find relevant pages, then get_page to read them before you answer.
Cite every page you rely on as a Markdown link to its URL.
If the documentation does not answer the question, say so instead of guessing.
Keep answers short and show code in fenced blocks.`;

const vercelChecks: AskAiChecks = {
  isBot: async () => (await checkBotId()).isBot,
  rateLimit: (request) => checkRateLimit(askAiRateLimitId, { request }),
};

function problem(status: number, detail: string): Response {
  return askAiProblem(status, "Invalid chat request", detail);
}

export async function POST(request: Request): Promise<Response> {
  // BotID and the Firewall answer only on Vercel; local and e2e servers skip them.
  if (env.VERCEL === "1") {
    const blocked = await guardAskAi(request, vercelChecks);
    if (blocked !== null) {
      return blocked;
    }
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return problem(400, "The body is not JSON.");
  }
  const parsed = await parseChatRequest(body);
  if (!parsed.ok) {
    return problem(parsed.status, parsed.detail);
  }

  const result = streamText({
    model,
    instructions,
    messages: await convertToModelMessages(parsed.history),
    tools: {
      search_docs: tool({
        description:
          "Search the PermDock documentation. Returns page titles, descriptions and URLs.",
        inputSchema: searchInput,
        execute: ({ query }) => docs.search(query, searchLimit),
      }),
      get_page: tool({
        description:
          "Read one documentation page as Markdown, by its URL path such as /docs/concepts/decisions.",
        inputSchema: pageInput,
        execute: async ({ path }) =>
          (await docs.getPage(path)) ?? `No documentation page at ${path}.`,
      }),
    },
    stopWhen: isStepCount(6),
    maxOutputTokens: 2000,
    telemetry: { functionId: "docs-ask-ai" },
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
