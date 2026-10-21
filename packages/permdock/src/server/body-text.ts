/**
 * The largest request body PermDock reads when a handler sets no smaller cap: 1
 * MiB.
 */
export const MAX_BODY_BYTES = 1_048_576;

export type BodyText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly cause: "too-large" | "unreadable" };

/**
 * The request or response body as UTF-8 text, read until `maxBytes` and no
 * further. A `Content-Length` above the cap is refused before the body is
 * touched; a body that runs past the cap whatever its header says is cancelled
 * mid-stream.
 */
export async function readBodyText(
  request: Request | Response,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<BodyText> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    return { ok: false, cause: "too-large" };
  }
  if (request.bodyUsed) {
    return { ok: false, cause: "unreadable" };
  }
  if (request.body === null) {
    return { ok: true, text: "" };
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    const reader: ReadableStreamDefaultReader<Uint8Array> =
      request.body.getReader();
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- chunks arrive in order; the cap is checked between them
      const chunk = await reader.read();
      if (chunk.done) {
        return { ok: true, text: text + decoder.decode() };
      }
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        // oxlint-disable-next-line no-await-in-loop -- runs once, on the way out of the loop
        await reader.cancel();
        return { ok: false, cause: "too-large" };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    return { ok: false, cause: "unreadable" };
  }
}
