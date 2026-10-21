import type { AuthEvent } from "../core/event-types.ts";
import type {
  TokenFailureCause,
  TokenSigner,
  TokenVerifier,
} from "../core/interfaces.ts";
import type { PrincipalSource } from "../core/principal-source.ts";
import type {
  Actor,
  AuthorizationDetail,
  Delegation,
  Principal,
  Subject,
} from "../core/subject.ts";
import type { Instant } from "../core/time.ts";

import { compact } from "../core/compact.ts";
import { freezeDeep } from "../core/freeze.ts";
import { isId } from "../core/ids.ts";
import { isForbiddenKey, ownRecord } from "../core/paths.ts";
import { anonymousSubject } from "../core/subject.ts";
import { epochSeconds, nowSeconds } from "../core/time.ts";
import {
  fromWireDelegation,
  toWireDelegation,
} from "../core/wire-delegation.ts";

const RUN_TICKET_TYP = "vnd.permdock.run+jwt";

/**
 * What started the run: a saved automation, a background job, or a caller's own
 * request.
 */
export type RunKind = "automation" | "job" | "caller";

/** RFC 8693 `act`: the party running the work, with the chain of earlier actors. */
export type RunActClaim = {
  readonly sub: string;
  readonly kind?: string;
  readonly act?: RunActClaim;
};

/**
 * The connector and tools a run may reach; carried for the adapter, never a
 * grant.
 */
export type RunBinding = {
  readonly connector?: string;
  readonly tools?: readonly string[];
};

export type RunAutomation = {
  readonly id: string;
  readonly version: number | string;
};

/**
 * The v1 claims of a `vnd.permdock.run+jwt`. At least one of `scope` and
 * `authorization_details` is present.
 */
export type RunTicket = {
  readonly v: 1;
  readonly iss: string;
  readonly sub: string;
  readonly aud: string | readonly string[];
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly kind: RunKind;
  readonly act?: RunActClaim;
  readonly scope?: string;
  readonly authorization_details?: readonly AuthorizationDetail[];
  /** Present exactly when `kind` is `automation`. */
  readonly automation?: RunAutomation;
  readonly tenant?: string;
  /**
   * The event that started the run, as JSON. Evaluation never reads it as a
   * grant.
   */
  readonly trigger?: Readonly<Record<string, unknown>>;
  readonly binding?: RunBinding;
};

/**
 * Every v1 claim of a `vnd.permdock.run+jwt`, the set `parseRunTicket` keeps. A
 * signing service passes only these to its signer.
 */
export const RUN_TICKET_CLAIMS: readonly (keyof RunTicket)[] = Object.freeze([
  "v",
  "iss",
  "sub",
  "aud",
  "jti",
  "iat",
  "exp",
  "kind",
  "act",
  "scope",
  "authorization_details",
  "automation",
  "tenant",
  "trigger",
  "binding",
]);

export type RunTicketInput = {
  /** The principal the run acts for (`sub`). */
  readonly principal: string;
  readonly kind: RunKind;
  /** Becomes `act`; a nested `act` on the actor is kept as the chain. */
  readonly actor?: Actor;
  /**
   * The run's ceiling. Required: a ticket never carries the principal's full
   * authority.
   */
  readonly delegation: Delegation;
  readonly automation?: RunAutomation;
  readonly tenant?: string;
  readonly trigger?: Readonly<Record<string, unknown>>;
  readonly binding?: RunBinding;
  /** `jti`; a fresh UUID when absent. */
  readonly id?: string;
  /** Lifetime in whole seconds. Exactly one of `expiresIn` and `expiresAt`. */
  readonly expiresIn?: number;
  readonly expiresAt?: Instant;
};

export type RunTicketOptions = {
  readonly audience?: string | readonly string[];
  readonly now?: Instant;
};

/** The live record of an automation, read on every use of its ticket. */
export type RunTicketAutomations = {
  automation: (
    id: string,
    options: { readonly tenant?: string },
  ) =>
    | {
        readonly id: string;
        readonly version: number | string;
        readonly revoked?: boolean;
      }
    | null
    | Promise<{
        readonly id: string;
        readonly version: number | string;
        readonly revoked?: boolean;
      } | null>;
};

/** `on('auth')` causes: a verification failure, or one of the run checks. */
export type RunTicketFailureCause =
  | TokenFailureCause
  | "automation-unavailable"
  | "automation-changed"
  | "owner-unavailable";

export type RunTicketSubjectOptions = {
  readonly verifier: TokenVerifier;
  readonly principals: PrincipalSource;
  /** Required to accept a `kind: 'automation'` ticket. */
  readonly automations?: RunTicketAutomations;
  readonly audience?: string | readonly string[];
  readonly issuer?: string;
  readonly clockTolerance?: number;
  readonly onAuth?: (event: AuthEvent) => void;
  readonly requestId?: string;
};

/** `subject.context.run` of a subject resolved from a run ticket. */
export type RunContext = {
  readonly id: string;
  readonly kind: RunKind;
  readonly automation?: RunAutomation;
  readonly binding?: RunBinding;
};

/** The principal of a run subject, with the verified ticket attached. */
export type RunPrincipal = Principal & { readonly runTicket: RunTicket };

type RunBody = Omit<RunTicket, "iss" | "aud" | "jti" | "iat" | "exp">;

const RUN_KINDS: readonly RunKind[] = ["automation", "job", "caller"];
const MAX_ACT_DEPTH = 8;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ENTRIES = 256;
const MAX_TOOLS = 64;

function isRunKind(value: unknown): value is RunKind {
  return RUN_KINDS.some((kind) => kind === value);
}

function isVersion(value: unknown): value is number | string {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    isId(value)
  );
}

function isNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function jsonCopy(
  value: unknown,
  depth: number,
  budget: { n: number },
): unknown {
  budget.n -= 1;
  if (budget.n < 0 || depth > MAX_JSON_DEPTH) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const copied = jsonCopy(item, depth + 1, budget);
      if (copied === undefined) {
        return undefined;
      }
      out.push(copied);
    }
    return out;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isForbiddenKey(key)) {
      return undefined;
    }
    const copied = jsonCopy(item, depth + 1, budget);
    if (copied === undefined) {
      return undefined;
    }
    out[key] = copied;
  }
  return out;
}

function parseTrigger(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const copied = jsonCopy(value, 0, { n: MAX_JSON_ENTRIES });
  return ownRecord(copied);
}

function parseAct(value: unknown, depth: number): RunActClaim | undefined {
  const record = ownRecord(value);
  if (record === undefined || depth > MAX_ACT_DEPTH || !isId(record["sub"])) {
    return undefined;
  }
  const kind = record["kind"];
  if (kind !== undefined && !isId(kind)) {
    return undefined;
  }
  const inner =
    record["act"] === undefined
      ? undefined
      : parseAct(record["act"], depth + 1);
  if (record["act"] !== undefined && inner === undefined) {
    return undefined;
  }
  return compact<RunActClaim>({ sub: record["sub"], kind, act: inner });
}

function parseAutomation(value: unknown): RunAutomation | undefined {
  const record = ownRecord(value);
  if (
    record === undefined ||
    !isId(record["id"]) ||
    !isVersion(record["version"])
  ) {
    return undefined;
  }
  return { id: record["id"], version: record["version"] };
}

function parseBinding(value: unknown): RunBinding | undefined {
  const record = ownRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const connector = record["connector"];
  const tools = record["tools"];
  if (connector !== undefined && !isId(connector)) {
    return undefined;
  }
  if (
    tools !== undefined &&
    !(
      Array.isArray(tools) &&
      tools.length <= MAX_TOOLS &&
      tools.every(isId) &&
      new Set(tools).size === tools.length
    )
  ) {
    return undefined;
  }
  return compact<RunBinding>({
    connector,
    // SAFETY: every entry passed isId above.
    tools: tools === undefined ? undefined : [...(tools as readonly string[])],
  });
}

function parseAudience(value: unknown): string | readonly string[] | undefined {
  if (isId(value)) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isId)) {
    return [...value];
  }
  return undefined;
}

function parseDetails(
  value: unknown,
): readonly AuthorizationDetail[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: AuthorizationDetail[] = [];
  for (const item of value) {
    const copied = parseTrigger(item);
    if (copied === undefined || typeof copied["type"] !== "string") {
      return undefined;
    }
    // SAFETY: copied is a JSON object whose `type` is a string, checked above.
    out.push(copied as AuthorizationDetail);
  }
  return out;
}

function optional<T>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  parse: (value: unknown) => T | undefined,
): { readonly ok: boolean; readonly value?: T } {
  const raw = record[key];
  if (raw === undefined) {
    return { ok: true };
  }
  const value = parse(raw);
  return value === undefined ? { ok: false } : { ok: true, value };
}

function parseBody(
  record: Readonly<Record<string, unknown>>,
): RunBody | undefined {
  const { sub, kind, tenant, scope } = record;
  if (
    record["v"] !== 1 ||
    !isId(sub) ||
    !isRunKind(kind) ||
    (tenant !== undefined && !isId(tenant)) ||
    (scope !== undefined && typeof scope !== "string")
  ) {
    return undefined;
  }
  const act = optional(record, "act", (value) => parseAct(value, 0));
  const details = optional(record, "authorization_details", parseDetails);
  const automation = optional(record, "automation", parseAutomation);
  const trigger = optional(record, "trigger", parseTrigger);
  const binding = optional(record, "binding", parseBinding);
  if (
    !act.ok ||
    !details.ok ||
    !automation.ok ||
    !trigger.ok ||
    !binding.ok ||
    (scope === undefined && details.value === undefined) ||
    (kind === "automation") !== (automation.value !== undefined)
  ) {
    return undefined;
  }
  return compact<RunBody>({
    v: 1,
    sub,
    kind,
    act: act.value,
    scope,
    authorization_details: details.value,
    automation: automation.value,
    tenant,
    trigger: trigger.value,
    binding: binding.value,
  });
}

/**
 * Validates untrusted run-ticket claims and returns a frozen copy with only the
 * v1 fields, or `undefined`. Unknown claims are dropped; a wrong type in a
 * known claim, a missing delegation, or an `automation` that does not match
 * `kind` rejects the whole ticket.
 */
export function parseRunTicket(claims: unknown): RunTicket | undefined {
  const record = ownRecord(claims);
  if (record === undefined) {
    return undefined;
  }
  const { iss, jti, iat, exp } = record;
  const aud = parseAudience(record["aud"]);
  const body = parseBody(record);
  if (
    body === undefined ||
    !isId(iss) ||
    !isId(jti) ||
    !isNumericDate(iat) ||
    !isNumericDate(exp) ||
    exp <= iat ||
    aud === undefined
  ) {
    return undefined;
  }
  return freezeDeep<RunTicket>({ ...body, iss, aud, jti, iat, exp });
}

function actClaim(actor: Actor, depth: number): RunActClaim | undefined {
  if (!isId(actor.id) || !isId(actor.kind)) {
    return undefined;
  }
  const nested = actor["act"];
  const chain = nested === undefined ? undefined : parseAct(nested, depth + 1);
  if (nested !== undefined && chain === undefined) {
    return undefined;
  }
  return compact<RunActClaim>({ sub: actor.id, kind: actor.kind, act: chain });
}

function expiryOf(input: RunTicketInput, issuedAt: number): number | undefined {
  if ((input.expiresIn === undefined) === (input.expiresAt === undefined)) {
    return undefined;
  }
  if (input.expiresIn !== undefined) {
    return Number.isSafeInteger(input.expiresIn) && input.expiresIn > 0
      ? issuedAt + input.expiresIn
      : undefined;
  }
  const at = nowSeconds(input.expiresAt);
  return at > issuedAt ? at : undefined;
}

function invalid(message: string): never {
  throw new TypeError(`PermDock: run ticket ${message}`);
}

/**
 * Signs a `vnd.permdock.run+jwt` for one run. Throws a `TypeError` on input a
 * verifier would refuse: no delegation, an `automation` that does not match
 * `kind`, a non-JSON `trigger`, or an expiry that is not in the future.
 */
export function signRunTicket(
  input: RunTicketInput,
  signer: TokenSigner,
  options: RunTicketOptions = {},
): Promise<string> {
  const issuedAt = nowSeconds(options.now);
  const expiresAt = expiryOf(input, issuedAt);
  if (expiresAt === undefined) {
    invalid("needs exactly one future expiresIn or expiresAt");
  }
  const act = input.actor === undefined ? undefined : actClaim(input.actor, 0);
  if (input.actor !== undefined && act === undefined) {
    invalid("actor needs an id and a kind");
  }
  const wire = toWireDelegation(input.delegation);
  const body = parseBody(
    compact({
      v: 1,
      sub: input.principal,
      kind: input.kind,
      act,
      scope: wire?.scope,
      authorization_details: wire?.authorization_details,
      automation: input.automation,
      tenant: input.tenant,
      trigger: input.trigger,
      binding: input.binding,
    }),
  );
  if (body === undefined) {
    invalid(
      "is invalid: check principal, kind, automation, delegation, trigger and binding",
    );
  }
  if (input.id !== undefined && !isId(input.id)) {
    invalid("id must be a non-empty string");
  }
  return signer.sign(
    body,
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: RUN_TICKET_TYP,
      audience: options.audience,
      expiresAt,
      issuedAt,
      jti: input.id ?? globalThis.crypto.randomUUID(),
    }),
  );
}

function isPrincipalRecord(value: unknown): value is Principal {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "id") &&
    "id" in value &&
    typeof value.id === "string"
  );
}

function actorOf(ticket: RunTicket): Actor | undefined {
  if (ticket.act === undefined) {
    return undefined;
  }
  return { id: ticket.act.sub, kind: ticket.act.kind ?? ticket.kind };
}

function delegationOf(ticket: RunTicket): Delegation {
  const delegation = fromWireDelegation(
    compact({
      scope: ticket.scope,
      authorization_details: ticket.authorization_details,
    }),
  ) ?? { scopes: [] };
  return ticket.act?.act === undefined
    ? delegation
    : { ...delegation, chain: ticket.act };
}

function mediaType(typ: string | undefined): string | undefined {
  const lower = typ?.toLowerCase();
  return lower?.startsWith("application/") === true
    ? lower.slice("application/".length)
    : lower;
}

type Checked =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly cause: RunTicketFailureCause };

async function checkAutomation(
  ticket: RunTicket,
  automations: RunTicketAutomations | undefined,
): Promise<RunTicketFailureCause | undefined> {
  const expected = ticket.automation;
  if (expected === undefined) {
    return undefined;
  }
  if (automations === undefined) {
    return "automation-unavailable";
  }
  try {
    const record: unknown = await automations.automation(
      expected.id,
      ticket.tenant === undefined ? {} : { tenant: ticket.tenant },
    );
    const live = ownRecord(record);
    if (
      live === undefined ||
      live["id"] !== expected.id ||
      live["revoked"] === true
    ) {
      return "automation-unavailable";
    }
    return live["version"] === expected.version
      ? undefined
      : "automation-changed";
  } catch {
    return "automation-unavailable";
  }
}

async function loadPrincipal(
  ticket: RunTicket,
  principals: PrincipalSource,
): Promise<Checked> {
  try {
    const loaded: unknown = await principals.principal(
      ticket.sub,
      ticket.tenant === undefined ? {} : { tenant: ticket.tenant },
    );
    if (!isPrincipalRecord(loaded) || loaded.id !== ticket.sub) {
      return { ok: false, cause: "owner-unavailable" };
    }
    return {
      ok: true,
      principal:
        ticket.tenant === undefined
          ? loaded
          : { ...loaded, tenant: ticket.tenant },
    };
  } catch {
    return { ok: false, cause: "owner-unavailable" };
  }
}

function anonymous(): Subject<RunPrincipal> {
  // SAFETY: the anonymous subject has a null principal, which fits any principal type.
  return anonymousSubject() as Subject<RunPrincipal>;
}

/**
 * Resolves a `vnd.permdock.run+jwt` into the subject the run acts as: the
 * principal loaded live from `principals`, the ticket's actor and its
 * delegation as the ceiling, with `context.trigger` and `context.run`. Every
 * failure (verification, malformed claims, an automation that is missing,
 * revoked or changed, a principal that is gone, a throwing source) is the
 * anonymous subject, never a throw.
 */
export async function subjectFromRunTicket(
  token: string | undefined | null,
  options: RunTicketSubjectOptions,
): Promise<Subject<RunPrincipal>> {
  if (typeof token !== "string" || token.length === 0) {
    return anonymous();
  }
  const deny = (cause: RunTicketFailureCause): Subject<RunPrincipal> => {
    try {
      options.onAuth?.(
        compact<AuthEvent>({
          reason: "invalid-token",
          cause,
          source: "run-ticket",
          typ: RUN_TICKET_TYP,
          issuer: options.issuer,
          requestId: options.requestId,
        }),
      );
    } catch {
      // a listener never changes the outcome
    }
    return anonymous();
  };
  let ticket: RunTicket | undefined;
  try {
    const verified = await options.verifier.verify(
      token,
      compact({
        typ: RUN_TICKET_TYP,
        audience: options.audience,
        issuer: options.issuer,
        clockTolerance: options.clockTolerance,
      }),
    );
    if (!verified.ok) {
      return deny(verified.cause);
    }
    if (mediaType(verified.header.typ) !== RUN_TICKET_TYP) {
      return deny("wrong-token-type");
    }
    ticket = parseRunTicket(verified.claims);
  } catch {
    return deny("malformed");
  }
  if (ticket === undefined) {
    return deny("invalid-claims");
  }
  if (ticket.exp <= epochSeconds()) {
    return deny("expired");
  }
  const automation = await checkAutomation(ticket, options.automations);
  if (automation !== undefined) {
    return deny(automation);
  }
  const loaded = await loadPrincipal(ticket, options.principals);
  if (!loaded.ok) {
    return deny(loaded.cause);
  }
  const run = compact<RunContext>({
    id: ticket.jti,
    kind: ticket.kind,
    automation: ticket.automation,
    binding: ticket.binding,
  });
  return Object.freeze(
    compact<Subject<RunPrincipal>>({
      principal: Object.freeze({ ...loaded.principal, runTicket: ticket }),
      actor: actorOf(ticket),
      delegation: delegationOf(ticket),
      context: Object.freeze(compact({ trigger: ticket.trigger, run })),
      expiresAt: ticket.exp,
    }),
  );
}
