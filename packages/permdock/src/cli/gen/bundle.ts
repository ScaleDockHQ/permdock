import { createHash } from "node:crypto";

import type { ClientBundle } from "../../core/snapshot-types.ts";

import { canonicalJson } from "../../core/canonical-json.ts";

/** The digest the bundle's header names, so a changed grant moves the line. */
export function bundleDigest(bundle: ClientBundle): string {
  return createHash("sha256").update(canonicalJson(bundle)).digest("base64url");
}

/**
 * The `"use client"` module a snapshot written with `omitStatic` resolves
 * against. A client module reaches the browser as a reference, so a server
 * component can pass it as the `bundle` prop without serialising it into the
 * page.
 */
export function bundleModule(bundle: ClientBundle, header: string): string {
  return `${[
    header,
    `"use client";`,
    `import type { ClientBundle } from "permdock";`,
    `export const clientBundle: ClientBundle = ${JSON.stringify(bundle, null, 2)};`,
  ].join("\n\n")}\n`;
}
