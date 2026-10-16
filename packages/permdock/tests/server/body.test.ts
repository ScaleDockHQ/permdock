import { describe, expect, it } from "vitest";

import {
  MAX_BODY_BYTES,
  bodyTooLarge,
  readBodyText,
} from "../../src/server/body.ts";

type StreamRequestInit = RequestInit & { readonly duplex: "half" };

function streamRequest(init: StreamRequestInit): Request {
  return new Request("https://app.test/x", init);
}

function streamed(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): { readonly request: Request; readonly pulled: () => number } {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[pulled];
        pulled += 1;
        if (chunk === undefined) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      },
    },
    { highWaterMark: 0 },
  );
  const request = streamRequest({
    method: "POST",
    headers,
    body,
    duplex: "half",
  });
  return { request, pulled: () => pulled };
}

describe("readBodyText", () => {
  it("reads a body under the cap", async () => {
    const request = new Request("https://app.test/x", {
      method: "POST",
      body: '{"note":"ok"}',
    });
    await expect(readBodyText(request, 64)).resolves.toStrictEqual({
      ok: true,
      text: '{"note":"ok"}',
    });
  });

  it("reads a missing body as empty text", async () => {
    await expect(
      readBodyText(new Request("https://app.test/x")),
    ).resolves.toStrictEqual({ ok: true, text: "" });
  });

  it("refuses a Content-Length over the cap without reading the body", async () => {
    const { request, pulled } = streamed([new Uint8Array(10)], {
      "content-length": "65",
    });
    await expect(readBodyText(request, 64)).resolves.toStrictEqual({
      ok: false,
      cause: "too-large",
    });
    expect(pulled()).toBe(0);
  });

  it("stops at the cap when Content-Length understates the body", async () => {
    const chunk = new Uint8Array(40);
    const { request, pulled } = streamed([chunk, chunk, chunk, chunk], {
      "content-length": "10",
    });
    await expect(readBodyText(request, 64)).resolves.toStrictEqual({
      ok: false,
      cause: "too-large",
    });
    expect(pulled()).toBeLessThan(4);
  });

  it("stops at the cap when the body has no Content-Length", async () => {
    const { request } = streamed([new Uint8Array(64), new Uint8Array(1)]);
    await expect(readBodyText(request, 64)).resolves.toStrictEqual({
      ok: false,
      cause: "too-large",
    });
  });

  it("counts bytes, not characters", async () => {
    const text = "é".repeat(40);
    const request = new Request("https://app.test/x", {
      method: "POST",
      body: text,
    });
    await expect(readBodyText(request, 64)).resolves.toStrictEqual({
      ok: false,
      cause: "too-large",
    });
  });

  it("decodes a character split across chunks", async () => {
    const bytes = new TextEncoder().encode("é");
    const { request } = streamed([bytes.slice(0, 1), bytes.slice(1)]);
    await expect(readBodyText(request, 64)).resolves.toStrictEqual({
      ok: true,
      text: "é",
    });
  });

  it("reports a stream that errors as unreadable", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("reset"));
      },
    });
    const request = streamRequest({ method: "POST", body, duplex: "half" });
    await expect(readBodyText(request)).resolves.toStrictEqual({
      ok: false,
      cause: "unreadable",
    });
  });

  it("reports a body already read or locked as unreadable", async () => {
    const used = new Request("https://app.test/x", {
      method: "POST",
      body: "{}",
    });
    await used.text();
    const locked = new Request("https://app.test/x", {
      method: "POST",
      body: "{}",
    });
    locked.body?.getReader();
    await expect(readBodyText(used)).resolves.toStrictEqual({
      ok: false,
      cause: "unreadable",
    });
    await expect(readBodyText(locked)).resolves.toStrictEqual({
      ok: false,
      cause: "unreadable",
    });
  });
});

describe("bodyTooLarge", () => {
  it("answers 413 Problem Details naming the cap", async () => {
    const response = bodyTooLarge();
    expect(response.status).toBe(413);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    await expect(response.json()).resolves.toMatchObject({
      status: 413,
      detail: `request body exceeds ${String(MAX_BODY_BYTES)} bytes`,
    });
  });
});
