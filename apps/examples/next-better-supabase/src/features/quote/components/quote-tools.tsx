"use client";

import type { ModelContext } from "permdock/webmcp";

import { usePermDock } from "permdock/react";
import { registerTools } from "permdock/webmcp";
import { useEffect } from "react";
import { z } from "zod";

import { permissions } from "../../../permissions.ts";
import { listQuotes, renameQuote } from "../quote-actions.ts";

const Rename = z.object({ id: z.uuid(), title: z.string().min(1) });

async function renameFrom(
  input: unknown,
  props: { readonly organizationId: string; readonly quoteId?: string },
) {
  const parsed = Rename.safeParse(input);
  const id = parsed.success ? parsed.data.id : props.quoteId;
  const title = parsed.success ? parsed.data.title : "";
  if (id === undefined || title === "") {
    return { renamed: null };
  }
  const renamed = await renameQuote(id, {
    title,
    organizationId: props.organizationId,
  });
  return renamed;
}

function modelContext(): ModelContext | null {
  const value: unknown = Reflect.get(document, "modelContext");
  if (
    typeof value !== "object" ||
    value === null ||
    !("registerTool" in value)
  ) {
    return null;
  }
  // SAFETY: registerTool is the only method ModelContext requires.
  return value as ModelContext;
}

/**
 * The same quotes operations as the agent route. WebMCP names each tool from
 * the permission action (`list`, `update`); the snapshot decides which appear.
 */
export function QuoteTools(props: {
  readonly organizationId: string;
  readonly quoteId?: string;
}) {
  const permdock = usePermDock();
  useEffect(() => {
    const handle = registerTools(modelContext(), permissions.quotes, {
      permdock,
      tenant: props.organizationId,
      handlers: {
        list: async () => {
          const listed = await listQuotes({
            organizationId: props.organizationId,
          });
          return listed;
        },
        update: async (call) => {
          const renamed = await renameFrom(call.input, {
            organizationId: props.organizationId,
            ...(props.quoteId === undefined ? {} : { quoteId: props.quoteId }),
          });
          return renamed;
        },
      },
    });
    return () => {
      handle.unregister();
    };
  }, [permdock, props.organizationId, props.quoteId]);
  return null;
}
