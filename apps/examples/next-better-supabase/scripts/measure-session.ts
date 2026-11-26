/** The demo sign-in cookie, and the token size figures taken from it. */

function accessToken(encoded: string): string | null {
  if (!encoded.startsWith("base64-")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded.slice("base64-".length), "base64url").toString(
        "utf8",
      ),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "access_token" in parsed &&
      typeof parsed.access_token === "string"
    ) {
      return parsed.access_token;
    }
  } catch {
    return null;
  }
  return null;
}

export async function signIn(
  base: string,
  userId: string,
): Promise<{ readonly cookie: string; readonly token: string | null }> {
  const response = await fetch(
    `${base}/api/test/sign-in?user=${userId}&next=${encodeURIComponent("/en")}`,
    { redirect: "manual" },
  );
  const parts = response.headers.getSetCookie().map((line) => {
    const pair = line.split(";")[0];
    return pair ?? "";
  });
  const cookie = parts.filter((part) => part !== "").join("; ");
  const encoded =
    parts
      .find((part) => part.startsWith("sb-example-auth-token="))
      ?.slice(22) ?? "";
  return { cookie, token: accessToken(encoded) };
}

export function tokenSizes(
  token: string | null,
  cookie: string,
): {
  readonly tokenBytes: number | null;
  readonly claimBytes: number | null;
  readonly cookieBytes: number;
} {
  if (token === null) {
    return { tokenBytes: null, claimBytes: null, cookieBytes: cookie.length };
  }
  const payload = token.split(".")[1] ?? "";
  return {
    tokenBytes: Buffer.byteLength(token),
    claimBytes: Buffer.from(payload, "base64url").length,
    cookieBytes: cookie.length,
  };
}
