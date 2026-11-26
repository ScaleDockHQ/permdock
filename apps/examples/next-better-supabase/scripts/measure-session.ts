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

const COOKIE = "sb-example-auth-token";

function chunkIndex(
  part: string,
): { readonly index: number; readonly value: string } | null {
  const match = new RegExp(`^${COOKIE}\\.(\\d+)=(.*)$`, "u").exec(part);
  const index = match?.[1];
  const value = match?.[2];
  if (index === undefined || value === undefined) {
    return null;
  }
  return { index: Number(index), value };
}

/** Supabase splits a session past ~3,180 characters into `name.0`, `name.1`. */
function sessionValue(parts: readonly string[]): string {
  const whole = parts.find((part) => part.startsWith(`${COOKIE}=`));
  if (whole !== undefined) {
    return whole.slice(COOKIE.length + 1);
  }
  return parts
    .map(chunkIndex)
    .filter((chunk) => chunk !== null)
    .toSorted((left, right) => left.index - right.index)
    .map((chunk) => chunk.value)
    .join("");
}
export async function signIn(
  base: string,
  userId: string,
): Promise<{ readonly cookie: string; readonly token: string | null }> {
  const response = await fetch(
    `${base}/api/sign-in?user=${userId}&next=${encodeURIComponent("/en")}`,
    { redirect: "manual" },
  );
  const parts = response.headers.getSetCookie().map((line) => {
    return line.split(";")[0];
  });
  const cookie = parts.filter((part) => part !== "").join("; ");
  const encoded = sessionValue(parts);
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
