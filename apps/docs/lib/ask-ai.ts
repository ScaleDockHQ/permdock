import { jsonSchema, safeValidateUIMessages, type UIMessage } from "ai";
import * as v from "valibot";

export const maxMessages = 20;
export const maxCharacters = 8000;

export type ChatRequest =
  | { readonly ok: true; readonly history: UIMessage[] }
  | { readonly ok: false; readonly status: 400 | 413; readonly detail: string };

function textOnly(messages: readonly UIMessage[]): UIMessage[] {
  const history: UIMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const parts = message.parts.filter((part) => part.type === "text");
    if (parts.length > 0) {
      history.push({ id: message.id, role: message.role, parts });
    }
  }
  return history;
}

function characters(messages: readonly UIMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text") {
        total += part.text.length;
      }
    }
  }
  return total;
}

/**
 * Keeps only user and assistant text, so a client cannot hand the model tool
 * results or system messages it did not produce.
 */
export async function parseChatRequest(body: unknown): Promise<ChatRequest> {
  const messages =
    typeof body === "object" && body !== null && "messages" in body
      ? body.messages
      : undefined;
  const validated = await safeValidateUIMessages({ messages });
  if (!validated.success) {
    return {
      ok: false,
      status: 400,
      detail: "messages is not a list of UI messages.",
    };
  }
  const history = textOnly(validated.data);
  if (history.at(-1)?.role !== "user") {
    return {
      ok: false,
      status: 400,
      detail: "The last message must be a user message.",
    };
  }
  if (history.length > maxMessages || characters(history) > maxCharacters) {
    return {
      ok: false,
      status: 413,
      detail: "The conversation is too long; start a new one.",
    };
  }
  return { ok: true, history };
}

function toolInput<const Schema extends v.GenericSchema>(
  schema: Schema,
  json: Parameters<typeof jsonSchema>[0],
) {
  return jsonSchema<v.InferOutput<Schema>>(json, {
    validate: (value) => {
      const result = v.safeParse(schema, value);
      return result.success
        ? { success: true, value: result.output }
        : { success: false, error: new v.ValiError(result.issues) };
    },
  });
}

export const searchInput = toolInput(
  v.object({ query: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) }),
  {
    type: "object",
    properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
    required: ["query"],
    additionalProperties: false,
  },
);

export const pageInput = toolInput(
  v.object({ path: v.pipe(v.string(), v.minLength(1), v.maxLength(300)) }),
  {
    type: "object",
    properties: { path: { type: "string", minLength: 1, maxLength: 300 } },
    required: ["path"],
    additionalProperties: false,
  },
);

/** The `@vercel/firewall` rule ID; the rule is configured in the Vercel Firewall. */
export const askAiRateLimitId = "docs-ask-ai";

export type AskAiChecks = {
  readonly isBot: () => Promise<boolean>;
  readonly rateLimit: (request: Request) => Promise<{
    readonly rateLimited: boolean;
    readonly error?: "not-found" | "blocked";
  }>;
};

export function askAiProblem(
  status: number,
  title: string,
  detail: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { title, status, detail },
    {
      status,
      headers: { ...headers, "Content-Type": "application/problem+json" },
    },
  );
}

/**
 * Bot and rate-limit checks before the model runs. A missing rate-limit rule
 * or a failed check closes Ask AI instead of leaving it unlimited.
 */
export async function guardAskAi(
  request: Request,
  checks: AskAiChecks,
): Promise<Response | null> {
  try {
    if (await checks.isBot()) {
      return askAiProblem(403, "Automated request", "Ask AI is for people.");
    }
    const { rateLimited, error } = await checks.rateLimit(request);
    if (error === "not-found") {
      return askAiProblem(503, "Ask AI unavailable", "Try again later.");
    }
    if (rateLimited) {
      return askAiProblem(
        429,
        "Too many questions",
        "Wait a minute before you ask again.",
        { "Retry-After": "60" },
      );
    }
    return null;
  } catch {
    return askAiProblem(503, "Ask AI unavailable", "Try again later.");
  }
}
