import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The upstream artefacts tests/standards asserts against. Each URL is pinned to a
// release, a schema `$id` or an RFC; bumping a revision means changing it here.
const JSON_SOURCES = {
  // Apache-2.0, cloudevents/spec v1.0.2.
  "cloudevents-1.0.2.schema.json":
    "https://raw.githubusercontent.com/cloudevents/spec/v1.0.2/cloudevents/formats/cloudevents.json",
  // Apache-2.0, OCSF 1.3.0 class definitions.
  "ocsf-1.3.0-authorize_session.json":
    "https://schema.ocsf.io/api/1.3.0/classes/authorize_session",
  "ocsf-1.3.0-account_change.json":
    "https://schema.ocsf.io/api/1.3.0/classes/account_change",
  // Apache-2.0, the JSON Schema published with A2A 1.0.0.
  "a2a-1.0.0.schema.json": "https://a2a-protocol.org/v1.0.0/spec/a2a.json",
  // Apache-2.0, the Arazzo 1.1 schema `$id`.
  "arazzo-1.1.schema.json":
    "https://spec.openapis.org/arazzo/1.1/schema/2026-04-15",
} as const;

const RFC_URL = (n: number): string =>
  `https://www.rfc-editor.org/rfc/rfc${String(n)}.txt`;

const out = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "permdock",
  "tests",
  "fixtures",
  "standards",
);

async function get(url: string, accept: string): Promise<Response> {
  const response = await fetch(url, { headers: { accept } });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${String(response.status)}`);
  }
  return response;
}

async function write(file: string, value: unknown): Promise<void> {
  const target = join(out, file);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  process.stdout.write(`wrote ${target}\n`);
}

// RFC text without page breaks, page footers and running headers.
async function rfc(n: number): Promise<string> {
  const text = await (await get(RFC_URL(n), "text/plain")).text();
  return text
    .split("\n")
    .filter(
      (line) =>
        !line.includes("\f") &&
        !/\[Page \d+\]\s*$/u.test(line) &&
        !/^RFC \d{4} {2,}/u.test(line),
    )
    .join("\n");
}

// A heading starts its line in the body and is indented in the table of contents.
function slice(text: string, from: string, to: string): string {
  const heading = text.indexOf(`\n${from}`);
  const start = heading >= 0 ? heading + 1 : text.indexOf(from);
  if (start < 0) {
    throw new Error(`marker not found: ${from}`);
  }
  const end = text.indexOf(to, start + from.length);
  if (end < 0) {
    throw new Error(`marker not found after ${from}: ${to}`);
  }
  return text.slice(start + from.length, end);
}

// RFC 8792 single-backslash unfolding.
function unfold(text: string): string {
  return text.replaceAll(/\\\n\s*/gu, "");
}

// A JSON value wrapped for the page: strings broken across lines rejoin with a space.
function prose(block: string): unknown {
  const start = block.search(/[[{]/u);
  const end = Math.max(block.lastIndexOf("}"), block.lastIndexOf("]"));
  return JSON.parse(block.slice(start, end + 1).replaceAll(/\s*\n\s*/gu, " "));
}

// A JSON value whose only wrapped strings are base64url, rejoined with nothing.
function dense(block: string): unknown {
  const start = block.search(/[[{]/u);
  const end = Math.max(block.lastIndexOf("}"), block.lastIndexOf("]"));
  return JSON.parse(block.slice(start, end + 1).replaceAll(/\s+/gu, ""));
}

function compact(block: string): string {
  return block.replaceAll(/\s+/gu, "");
}

async function rfc7520(): Promise<void> {
  const text = await rfc(7520);
  const hs = slice(text, "4.4.  HMAC-SHA2 Integrity Protection", "Figure 35:");
  await write("rfc7520-jws.json", {
    source: "RFC 7520 sections 3.3, 3.5, 4.1 and 4.4",
    rsaPublicKey: dense(slice(text, "3.3.  RSA Public Key", "Figure 3:")),
    hmacKey: dense(slice(text, "3.5.  Symmetric Key", "Figure 5:")),
    rs256: compact(
      slice(
        text,
        "The resulting JWS object using the JWS Compact Serialization:",
        "Figure 13:",
      ),
    ),
    hs256: compact(slice(hs, "Compact Serialization:", "Figure 34:")),
  });
}

async function rfc8037(): Promise<void> {
  const text = await rfc(8037);
  const thumbprint = /Thumbprint representation\s+of "([^"]+)"/u.exec(text);
  await write("rfc8037-ed25519.json", {
    source: "RFC 8037 appendix A.1 to A.5",
    privateKey: dense(
      slice(text, "A.1.  Ed25519 Private Key", "The hexadecimal"),
    ),
    publicKey: dense(slice(text, "A.2.  Ed25519 Public Key", "A.3.")),
    thumbprint: thumbprint?.[1],
    jws: compact(slice(text, "base64url encoding of the signature):", "A.5.")),
  });
}

async function rfc9421(): Promise<void> {
  const text = unfold(await rfc(9421));
  const message = slice(
    text,
    "For requests, this test-request message is used:",
    "For responses",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("NOTE:"));
  const lines = message.slice(message.findIndex((line) => line !== ""));
  const blank = lines.indexOf("");
  const [requestLine = "", ...headerLines] = lines.slice(0, blank);
  const [method, target] = requestLine.split(" ");
  const headers = Object.fromEntries(
    headerLines.map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    }),
  );
  const host = String(headers["Host"]);
  const signed = slice(text, "under the label sig-b26:", "B.3.")
    .split("\n")
    .map((line) => line.trim());
  const field = (name: string): string | undefined =>
    signed.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
  await write("rfc9421-ed25519.json", {
    source: "RFC 9421 appendix B.1.4, B.2 and B.2.6",
    key: dense(
      slice(
        slice(text, "B.1.4.  Example Ed25519 Test Key", "B.1.5."),
        "in JWK format:",
        "}",
      ).concat("}"),
    ),
    request: {
      method,
      url: `https://${host}${String(target)}`,
      headers,
      body: lines
        .slice(blank + 1)
        .filter((line) => line !== "")
        .join("\n"),
    },
    signatureInput: field("Signature-Input"),
    signature: field("Signature"),
  });
}

async function rfc7643(): Promise<void> {
  const text = await rfc(7643);
  await write("rfc7643-schemas.json", {
    source: "RFC 7643 sections 8.6, 8.7.1 and 8.7.2",
    resourceTypes: prose(
      slice(text, "8.6.  Resource Type Representation", "Figure 8:"),
    ),
    resourceSchemas: prose(
      slice(text, "8.7.1.  Resource Schema Representation", "Figure 9:"),
    ),
    serviceProviderSchemas: prose(
      slice(text, "8.7.2.  Service Provider Schema", "Figure 10:"),
    ),
  });
}

await mkdir(out, { recursive: true });
await Promise.all([
  ...Object.entries(JSON_SOURCES).map(
    async ([file, url]: readonly [string, string]) => {
      const response = await get(
        url,
        "application/schema+json, application/json",
      );
      await write(file, await response.json());
    },
  ),
  rfc7520(),
  rfc8037(),
  rfc9421(),
  rfc7643(),
]);
