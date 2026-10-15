import { presetItem } from "@/lib/preset-item";

const PRESET = /^preset-(?<code>p\d[\w-]+)\.json$/u;

/**
 * `/r/preset-<code>.json`: the shadcn registry item for a preset, generated
 * on request from the code. The static recipes in public/r are served
 * before this route; anything else is 404.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  const code = PRESET.exec(name)?.groups?.["code"];
  const item =
    code === undefined ? null : presetItem(code, new URL(request.url).origin);
  if (item === null) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json(item, {
    headers: { "cache-control": "public, max-age=3600, immutable" },
  });
}
