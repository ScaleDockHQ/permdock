import type { CaepEventName } from "./types.ts";

export const BACKCHANNEL_LOGOUT_EVENT =
  "http://schemas.openid.net/event/backchannel-logout";

const CAEP_PREFIX = "https://schemas.openid.net/secevent/caep/event-type/";

const CAEP_NAMES: ReadonlySet<CaepEventName> = new Set([
  "session-revoked",
  "credential-change",
  "assurance-level-change",
  "token-claims-change",
  "device-compliance-change",
]);

export function caepName(uri: string): CaepEventName | undefined {
  if (!uri.startsWith(CAEP_PREFIX)) {
    return undefined;
  }
  const name = uri.slice(CAEP_PREFIX.length);
  // SAFETY: a string lookup in the set; only a member passes, so the return below is a CaepEventName.
  if (CAEP_NAMES.has(name as CaepEventName)) {
    // SAFETY: CAEP_NAMES.has just confirmed the name is a CaepEventName.
    return name as CaepEventName;
  }
  return undefined;
}
