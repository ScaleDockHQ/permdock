import type { CaepEventName, RiscEventName, SsfEventName } from "./types.ts";

export const BACKCHANNEL_LOGOUT_EVENT =
  "http://schemas.openid.net/event/backchannel-logout";

/** SSF 1.0 section 8.1.4.1. */
export const VERIFICATION_EVENT =
  "https://schemas.openid.net/secevent/ssf/event-type/verification";

export const CAEP_PREFIX =
  "https://schemas.openid.net/secevent/caep/event-type/";
export const RISC_PREFIX =
  "https://schemas.openid.net/secevent/risc/event-type/";

const CAEP_NAMES: readonly CaepEventName[] = [
  "session-revoked",
  "credential-change",
  "assurance-level-change",
  "token-claims-change",
  "device-compliance-change",
  "session-established",
  "session-presented",
  "risk-level-change",
];

const RISC_NAMES: readonly RiscEventName[] = [
  "account-disabled",
  "account-purged",
  "credential-compromise",
];

/** The CAEP or RISC name of an event URI PermDock knows, else `undefined`. */
export function eventName(uri: string): SsfEventName | undefined {
  if (uri.startsWith(CAEP_PREFIX)) {
    const name = uri.slice(CAEP_PREFIX.length);
    return CAEP_NAMES.find((known) => known === name);
  }
  if (uri.startsWith(RISC_PREFIX)) {
    const name = uri.slice(RISC_PREFIX.length);
    return RISC_NAMES.find((known) => known === name);
  }
  return undefined;
}

/** RISC events that end every session of the subject. */
export function revokesAccount(name: string): boolean {
  return RISC_NAMES.some((known) => known === name);
}
