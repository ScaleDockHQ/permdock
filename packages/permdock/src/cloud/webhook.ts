import type {
  AccessEvent,
  CredentialEvent,
  DecisionEvent,
  DirectoryEvent,
  MembershipEvent,
  TokenFailureCause,
  TokenVerifier,
} from '../core/interfaces.ts';
import type {
  CatalogEventData,
  CatalogFindingCode,
  CloudEventType,
} from '../core/sink.ts';
import type { JsonWebKeySet } from '../jwt/types.ts';
import type { ReplayStore } from '../ssf/types.ts';

import { freezeDeep } from '../core/freeze.ts';
import { isForbiddenKey } from '../core/paths.ts';
import { CLOUD_EVENT_TYPES } from '../core/sink.ts';
import { joseTokenVerifier } from '../jwt/verifier.ts';

type Envelope<TType extends CloudEventType, TData> = {
  readonly specversion: '1.0';
  readonly type: TType;
  readonly source: string;
  readonly subject?: string;
  readonly id: string;
  readonly time: string;
  readonly datacontenttype: 'application/json';
  readonly data: TData;
};

/** A CloudEvent PermDock Cloud delivers, discriminated by `type`. */
export type PermDockCloudEvent =
  | Envelope<'dev.permdock.decision', DecisionEvent>
  | Envelope<'dev.permdock.approval', DecisionEvent>
  | Envelope<'dev.permdock.directory', DirectoryEvent>
  | Envelope<'dev.permdock.membership', MembershipEvent>
  | Envelope<'dev.permdock.credential', CredentialEvent>
  | Envelope<'dev.permdock.catalog', CatalogEventData>
  | Envelope<'dev.permdock.access.started', AccessEvent>
  | Envelope<'dev.permdock.access.ended', AccessEvent>
  | Envelope<'dev.permdock.access.revoked', AccessEvent>;

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
  | 'unsigned'
  | 'invalid-token'
  | 'invalid-events'
  | 'replayed';

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

const TYPES: ReadonlySet<string> = new Set(Object.values(CLOUD_EVENT_TYPES));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUnsafeKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasUnsafeKey);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some(
    (key) => isForbiddenKey(key) || hasUnsafeKey(value[key]),
  );
}

const FINDING_CODES: ReadonlySet<unknown> = new Set<CatalogFindingCode>([
  'permission-removed',
  'not-hostable',
  'grantee-removed',
  'approval-tightened',
]);

function isFinding(value: unknown): boolean {
  return (
    isRecord(value) &&
    FINDING_CODES.has(value['code']) &&
    typeof value['permission'] === 'string' &&
    (value['grant'] === undefined || typeof value['grant'] === 'string')
  );
}

function validData(
  type: CloudEventType,
  data: Record<string, unknown>,
): boolean {
  switch (type) {
    case 'dev.permdock.decision':
      return (
        data['type'] === 'decision' && typeof data['permission'] === 'string'
      );
    case 'dev.permdock.approval':
      return (
        data['type'] === 'decision' &&
        (data['phase'] === 'requested' || data['phase'] === 'resolved')
      );
    case 'dev.permdock.directory':
      return data['type'] === 'directory' && typeof data['tenant'] === 'string';
    case 'dev.permdock.membership':
      return data['type'] === 'membership' && isRecord(data['principal']);
    case 'dev.permdock.credential':
      return (
        data['type'] === 'credential' &&
        isRecord(data['credential']) &&
        typeof data['credential']['id'] === 'string' &&
        (data['credential']['kind'] === 'user' ||
          data['credential']['kind'] === 'service') &&
        isRecord(data['principal']) &&
        (data['operation'] === 'created' ||
          data['operation'] === 'used' ||
          data['operation'] === 'rotated' ||
          data['operation'] === 'revoked')
      );
    case 'dev.permdock.catalog':
      return (
        (data['kind'] === 'publish' || data['kind'] === 'drift') &&
        typeof data['fingerprint'] === 'string' &&
        (data['previous'] === undefined ||
          typeof data['previous'] === 'string') &&
        (data['findings'] === undefined ||
          (Array.isArray(data['findings']) &&
            data['findings'].every(isFinding)))
      );
    case 'dev.permdock.access.started':
    case 'dev.permdock.access.ended':
    case 'dev.permdock.access.revoked':
      return (
        data['type'] === 'access' &&
        typeof data['tenant'] === 'string' &&
        isRecord(data['principal']) &&
        // SAFETY: isRecord checked data['principal'] on the line above.
        typeof (data['principal'] as Record<string, unknown>)['id'] === 'string'
      );
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/**
 * Validates one CloudEvent against the closed type list and its data shape;
 * returns `null` for anything else, never throws.
 */
export function parseCloudEvent(value: unknown): PermDockCloudEvent | null {
  if (
    !isRecord(value) ||
    hasUnsafeKey(value) ||
    value['specversion'] !== '1.0' ||
    typeof value['type'] !== 'string' ||
    !TYPES.has(value['type']) ||
    typeof value['source'] !== 'string' ||
    typeof value['id'] !== 'string' ||
    typeof value['time'] !== 'string' ||
    (value['subject'] !== undefined && typeof value['subject'] !== 'string') ||
    !isRecord(value['data']) ||
    // SAFETY: TYPES.has checked value['type'] against the CloudEventType list above.
    !validData(value['type'] as CloudEventType, value['data'])
  ) {
    return null;
  }
  // SAFETY: a JSON copy of value, whose envelope and data were validated above.
  return freezeDeep(JSON.parse(JSON.stringify(value)) as PermDockCloudEvent);
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
        typeof options.jwks === 'string' ? new URL(options.jwks) : options.jwks,
      algorithms: ['Ed25519', 'ES256'],
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
 * `typ: permdock-decisions+jwt` whose `events` claim holds CloudEvents.
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
    return { ok: false, reason: 'unsigned' };
  }
  if (!isCompactJws(body)) {
    return { ok: false, reason: 'unsigned' };
  }
  const verifier = verifierFor(options);
  if (verifier === undefined) {
    return { ok: false, reason: 'invalid-token', cause: 'jwks-unavailable' };
  }
  let verified: Awaited<ReturnType<TokenVerifier['verify']>>;
  try {
    verified = await verifier.verify(body, {
      typ: 'permdock-decisions+jwt',
      audience: options.audience,
    });
  } catch {
    return { ok: false, reason: 'invalid-token', cause: 'malformed' };
  }
  if (!verified.ok) {
    return { ok: false, reason: 'invalid-token', cause: verified.cause };
  }
  const jti = verified.claims['jti'];
  const raw = verified.claims['events'];
  if (typeof jti !== 'string' || !Array.isArray(raw)) {
    return { ok: false, reason: 'invalid-events' };
  }
  const events: PermDockCloudEvent[] = [];
  for (const item of raw) {
    const parsed = parseCloudEvent(item);
    if (parsed === null) {
      return { ok: false, reason: 'invalid-events' };
    }
    events.push(parsed);
  }
  if (options.replay !== undefined) {
    const key = `permdock-webhook:${jti}`;
    const expiresAt =
      typeof verified.claims.exp === 'number' ? verified.claims.exp : undefined;
    try {
      if (options.replay.claim === undefined) {
        if (await options.replay.seen(key)) {
          return { ok: false, reason: 'replayed' };
        }
        await options.replay.remember(key, expiresAt);
      } else if (!(await options.replay.claim(key, expiresAt))) {
        return { ok: false, reason: 'replayed' };
      }
    } catch {
      return { ok: false, reason: 'replayed' };
    }
  }
  return freezeDeep({ ok: true as const, id: jti, events });
}
