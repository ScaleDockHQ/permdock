import "server-only";
import { sqlTransport } from "better-supabase/blocks";
import { createShareLinks } from "better-supabase/blocks/share-links";
import { decodeJwt } from "jose";
import { getPermDockSync } from "permdock";
import { subjectFromShareLink } from "permdock/better-supabase";
import { exchangeCapability } from "permdock/supabase";

import type { QuoteRow } from "./access.ts";

import { env } from "../env.ts";
import { permissions, policy } from "../policy.ts";
import { postgres } from "./supabase/server.ts";

/** `resolve` runs as anon: its security definer function reads only the link table. */
const shareLinks = createShareLinks({ transport: sqlTransport(postgres.anon) });

type SigningKey = Readonly<Record<string, unknown>> & { readonly kid: string };

function signingKey(raw: string | undefined): SigningKey | null {
  if (raw === undefined) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" &&
    parsed !== null &&
    "kid" in parsed &&
    typeof parsed.kid === "string"
    ? { ...parsed, kid: parsed.kid }
    : null;
}

/**
 * The quote a share-link token points at, read under RLS with the link's
 * capability; `null` for an unknown, revoked or expired link. Each call
 * counts one use of the link.
 */
export async function sharedQuote(token: string): Promise<QuoteRow | null> {
  const subject = await subjectFromShareLink(token, {
    shareLinks,
    links: {
      quote: { resource: permissions.quotes, roles: { view: ["guest"] } },
    },
    ttl: 300,
  });
  const quote = subject.principal?.capability.on.id;
  const key = signingKey(env.signingKey);
  if (
    quote === undefined ||
    key === null ||
    !getPermDockSync(policy, subject).can(permissions.quotes.read, {
      id: quote,
    })
  ) {
    return null;
  }
  const accessToken = await exchangeCapability(subject, {
    key,
    alg: "ES256",
    kid: key.kid,
    ttl: 300,
  });
  if (accessToken === undefined) {
    return null;
  }
  // The claims the Data API would set from this token; the quotes_select_anon policy reads `capability`.
  const rows = await postgres
    .asUser(decodeJwt(accessToken))
    .queryRaw<QuoteRow>(
      "select id, title, amount_minor, currency from public.quotes where id = $1",
      [quote],
    );
  return rows[0] ?? null;
}
