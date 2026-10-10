import { cacheLife } from "next/cache";

import { markdownHeaders } from "@/lib/shared";
import { renderDocsLlmsIndex } from "@/lib/source";

async function llmsIndex(): Promise<string> {
  "use cache";
  cacheLife("max");
  return renderDocsLlmsIndex();
}

export async function GET(): Promise<Response> {
  return new Response(await llmsIndex(), { headers: markdownHeaders });
}
