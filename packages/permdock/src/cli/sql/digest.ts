import { bundleDigest } from "./policy-bundle.ts";

const DIGEST = /^(-- permdock helpers \(.*\)) (sha-256:[A-Za-z0-9_-]+)$/u;

/**
 * Adds the `sha-256:` digest of everything after the first line to that line,
 * so a reader can tell a generated helpers file from an edited or older one.
 * The digest covers the text a database executes, not the version of the CLI,
 * so a release that writes the same helpers writes the same bytes.
 */
export function stampHelpers(text: string): string {
  const newline = text.indexOf("\n");
  if (newline < 0) {
    return text;
  }
  const first = text.slice(0, newline);
  const rest = text.slice(newline + 1);
  return `${first} ${bundleDigest(rest)}\n${rest}`;
}

export type HelpersStamp = {
  /** The digest the first line states. */
  readonly stated: string;
  /** The digest of the text after that line. */
  readonly actual: string;
};

/** The stamp of a helpers file, or `undefined` for text that carries none. */
export function readStamp(text: string): HelpersStamp | undefined {
  const newline = text.indexOf("\n");
  if (newline < 0) {
    return undefined;
  }
  const match = DIGEST.exec(text.slice(0, newline));
  const stated = match?.[2];
  return stated === undefined
    ? undefined
    : { stated, actual: bundleDigest(text.slice(newline + 1)) };
}
