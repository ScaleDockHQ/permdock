import type { Subject } from "permdock";
import type { ToolApprovalStatus } from "permdock/ai-sdk";

import { defineOperations } from "permdock";
import { createPermDock } from "permdock/ai-sdk";
import { z } from "zod";

import { permissions, policy } from "../policy.ts";

/** Runs SQL as the caller, so RLS sees the same claims the subject came from. */
export type CallerQuery = (
  sql: string,
  params?: readonly unknown[],
) => Promise<readonly unknown[]>;

export type QuoteAgentContext = {
  /** From `subjectFromBetterSupabase(session)` on the verified token; carries `act`. */
  readonly subject: Subject;
  /** The organization the request acts in, from the route, never from the model. */
  readonly organization: string;
  readonly query: CallerQuery;
};

/** `pg` returns `bigint` as a string; the `Quote` schema the decision validates wants a number. */
const QuoteRecord = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  customer_id: z.uuid(),
  title: z.string(),
  amount_minor: z.coerce.number().int(),
  currency: z.string(),
});

export type QuoteRow = z.infer<typeof QuoteRecord>;

const COLUMNS =
  "id, organization_id, customer_id, title, amount_minor, currency";

const RenameQuote = z.object({ id: z.uuid(), title: z.string().min(1) });

export type QuoteToolName = "quotes.read" | "quotes.update";

export type QuoteToolResult =
  | { readonly ok: true; readonly rows: readonly QuoteRow[] }
  | {
      readonly ok: false;
      readonly status: Exclude<ToolApprovalStatus, "approved">;
    };

function quoteTools(
  query: CallerQuery,
): Record<QuoteToolName, (input: unknown) => Promise<readonly QuoteRow[]>> {
  return {
    "quotes.read": async () =>
      QuoteRecord.array().parse(
        await query(`select ${COLUMNS} from public.quotes order by title`),
      ),
    "quotes.update": async (input) => {
      const { id, title } = RenameQuote.parse(input);
      return QuoteRecord.array().parse(
        await query(
          `update public.quotes set title = $2 where id = $1 returning ${COLUMNS}`,
          [id, title],
        ),
      );
    },
  };
}

/**
 * One request's quotes agent. The tool names match the keys a token lists in
 * `act.tools`, so a tool the token does not name is denied with
 * `agent-tool-not-delegated` before its permission is checked.
 */
export function quoteAgent(context: QuoteAgentContext) {
  const { toolApproval, capabilityMiddleware } = createPermDock(policy, {
    subject: () => context.subject,
    tenant: context.organization,
    operations: defineOperations(permissions, {
      "quotes.read": { permission: permissions.quotes.list },
      "quotes.update": {
        permission: permissions.quotes.update,
        data: async (input) => {
          const { id } = RenameQuote.parse(input);
          const [row] = await context.query(
            `select ${COLUMNS} from public.quotes where id = $1`,
            [id],
          );
          return row === undefined ? undefined : QuoteRecord.parse(row);
        },
      },
    }),
  });
  const tools = quoteTools(context.query);

  /** What the AI SDK does with `toolApproval`: run the tool only when it answers `approved`. */
  const call = async (
    toolName: QuoteToolName,
    input: unknown = {},
  ): Promise<QuoteToolResult> => {
    const status = await toolApproval({ toolCall: { toolName, input } });
    return status === "approved"
      ? { ok: true, rows: await tools[toolName](input) }
      : { ok: false, status };
  };

  return { toolApproval, capabilityMiddleware, call };
}
