function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
}

/** `length` random bytes as base64url, from Web Crypto. */
export function randomToken(length: number): string {
  return base64url(globalThis.crypto.getRandomValues(new Uint8Array(length)));
}

export type Pkce = {
  readonly verifier: string;
  readonly challenge: string;
};

/** An RFC 7636 verifier of 43 characters and its `S256` challenge. */
export async function pkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}
