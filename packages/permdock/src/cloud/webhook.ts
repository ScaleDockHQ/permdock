import type {
  AccessEvent,
  CredentialEvent,
  DecisionEvent,
  DirectoryEvent,
  MembershipEvent,
} from "../core/event-types.ts";
import type { TokenFailureCause, TokenVerifier } from "../core/interfaces.ts";
import type {
  CLOUD_EVENT_TYPES,
  CatalogEventData,
  CloudEvent,
  CloudEventType,
} from "../core/sink.ts";
import type { JsonWebKeySet } from "../jwt/types.ts";
import type { ReplayStore } from "../ssf/types.ts";

import { freezeDeep } from "../core/freeze.ts";
import { parseCloudEvent as parseCoreCloudEvent } from "../core/parse-sink-events.ts";
import { joseTokenVerifier } from "../jwt/verifier.ts";

type Envelope<TType extends CloudEventType, TData> = Omit<
  CloudEvent,
  "type" | "data"
> & {
  readonly type: TType;
  readonly data: TData;
};

type Types = typeof CLOUD_EVENT_TYPES;

/** A CloudEvent PermDock Cloud delivers, discriminated by `type`. */
export type PermDockCloudEvent =
  | Envelope<Types["decision"], DecisionEvent>
  | Envelope<
      | Types["approvalRequested"]
      | Types["approvalResolved"]
      | Types["approvalExpired"]
      | Types["approvalCancelled"],
      DecisionEvent
    >
  | Envelope<
      | Types["directoryCreated"]
      | Types["directoryReplaced"]
      | Types["directoryPatched"]
      | Types["directoryDeleted"],
      DirectoryEvent
    >
  | Envelope<
      | Types["membershipAdded"]
      | Types["membershipRemoved"]
      | Types["membershipChanged"],
      MembershipEvent
    >
  | Envelope<
      | Types["credentialCreated"]
      | Types["credentialUsed"]
      | Types["credentialRotated"]
      | Types["credentialRevoked"],
      CredentialEvent
    >
  | Envelope<
      Types["catalogPublished"] | Types["catalogDrifted"],
      CatalogEventData
    >
  | Envelope<
      Types["supportSessionStarted"] | Types["supportSessionEnded"],
      AccessEvent
    >;

export type VerifyWebhookOptions = {
  /** Your receiver's URL; the batch `aud` must name it. */
  readonly audience: string | readonly string[];
  /** A verifier over the Cloud JWKS; built from `jwks` when absent. */
  readonly verifier?: TokenVerifier;
  /** `cloud().jwks`, a JWKS URL, or an inline key set. */
  readonly jwks?: string | URL | JsonWebKeySet;
  /** Drops a batch whose `jti` was already delivered. */
  readonly replay?: ReplayStore;
};

export type WebhookFailureReason =
  | "unsigned"
  | "invalid-token"
  | "invalid-events"
  | "replayed";

export type VerifiedWebhook =
  | {
      readonly ok: true;
      readonly id: string;
      readonly events: readonly PermDockCloudEvent[];
    }
  | {
      readonly ok: false;
      readonly reason: WebhookFailureReason;
      readonly cause?: TokenFailureCause;
    };

/**
 * Validates one CloudEvent against the closed type list, its `dataschema` and
 * its data shape; returns `null` for anything else, never throws.
 */
export function parseCloudEvent(value: unknown): PermDockCloudEvent | null {
  // SAFETY: parseCoreCloudEvent checked that data matches the family its type names.
  return parseCoreCloudEvent(value) as PermDockCloudEvent | null;
}

function verifierFor(options: VerifyWebhookOptions): TokenVerifier | undefined {
  if (options.verifier !== undefined) {
    return options.verifier;
  }
  if (options.jwks === undefined) {
    return undefined;
  }
  try {
    return joseTokenVerifier({
      jwks:
        typeof options.jwks === "string" ? new URL(options.jwks) : options.jwks,
      algorithms: ["Ed25519", "ES256"],
    });
  } catch {
    return undefined;
  }
}

function isCompactJws(value: string): boolean {
  return /^[\w-]+\.[\w-]+\.[\w-]+$/u.test(value);
}

/**
 * Verifies a PermDock Cloud webhook delivery: a compact JWS with
 * `typ: vnd.permdock.evidence+jwt` whose `events` claim holds CloudEvents.
 * There is no unsigned mode, and it never throws.
 */
export async function verifyWebhook(
  request: Request,
  options: VerifyWebhookOptions,
): Promise<VerifiedWebhook> {
  let body: string;
  try {
    body = (await request.text()).trim();
  } catch {
    return { ok: false, reason: "unsigned" };
  }
  if (!isCompactJws(body)) {
    return { ok: false, reason: "unsigned" };
  }
  const verifier = verifierFor(options);
  if (verifier === undefined) {
    return { ok: false, reason: "invalid-token", cause: "jwks-unavailable" };
  }
  let verified: Awaited<ReturnType<TokenVerifier["verify"]>>;
  try {
    verified = await verifier.verify(body, {
      typ: "vnd.permdock.evidence+jwt",
      audience: options.audience,
    });
  } catch {
    return { ok: false, reason: "invalid-token", cause: "malformed" };
  }
  if (!verified.ok) {
    return { ok: false, reason: "invalid-token", cause: verified.cause };
  }
  const jti = verified.claims["jti"];
  const raw = verified.claims["events"];
  if (typeof jti !== "string" || !Array.isArray(raw)) {
    return { ok: false, reason: "invalid-events" };
  }
  const events: PermDockCloudEvent[] = [];
  for (const item of raw) {
    const parsed = parseCloudEvent(item);
    if (parsed === null) {
      return { ok: false, reason: "invalid-events" };
    }
    events.push(parsed);
  }
  if (options.replay !== undefined) {
    const key = `permdock-webhook:${jti}`;
    const expiresAt =
      typeof verified.claims.exp === "number" ? verified.claims.exp : undefined;
    try {
      if (options.replay.claim === undefined) {
        if (await options.replay.seen(key)) {
          return { ok: false, reason: "replayed" };
        }
        await options.replay.remember(key, expiresAt);
      } else if (!(await options.replay.claim(key, expiresAt))) {
        return { ok: false, reason: "replayed" };
      }
    } catch {
      return { ok: false, reason: "replayed" };
    }
  }
  return freezeDeep({ ok: true as const, id: jti, events });
}
