import { cacheLife } from "next/cache";

import { markdownHeaders } from "@/lib/shared";
import { docsLlms } from "@/lib/source";

async function llmsFull(): Promise<string> {
  "use cache";
  cacheLife("max");
  return docsLlms.full();
}

export async function GET(): Promise<Response> {
  return new Response(await llmsFull(), { headers: markdownHeaders });
}
