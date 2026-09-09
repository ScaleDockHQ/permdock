import type {
  JwtClaims,
  TokenFailureCause,
  TokenVerifier,
  VerifiedToken,
} from '../core/interfaces.ts';
import type {
  PollHandle,
  PollOptions,
  PollResult,
  ReplayStore,
  SetSubject,
  SsfAuditEvent,
  SsfEventHandler,
  SsfEventInput,
  SsfEventListener,
  SsfOnEvent,
  SsfReceiver,
  SsfSubject,
  SsfSubjectMapper,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { BACKCHANNEL_LOGOUT_EVENT, caepName } from './events.ts';

const SET_TYP = 'secevent+jwt';
const LOGOUT_TYP = 'logout+jwt';
const SET_CONTENT = 'application/secevent+jwt';
const LOGOUT_CONTENT = 'application/x-www-form-urlencoded';

type ReceiverConfig = {
  readonly verifier: TokenVerifier;
  readonly issuer?: string;
  readonly audience: string | readonly string[];
  readonly subject: SsfSubjectMapper;
  readonly onEvent: SsfOnEvent;
  readonly replay: ReplayStore;
  readonly clockTolerance?: number;
};

type IngestOk = { readonly ok: true };
type IngestFail = {
  readonly ok: false;
  readonly err: string;
  readonly description: string;
  readonly cause?: TokenFailureCause;
};
type IngestResult = IngestOk | IngestFail;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rfc8935(status: number, err: string, description: string): Response {
  return jsonResponse(status, { err, description });
}

function errForCause(cause: TokenFailureCause): string {
  switch (cause) {
    case 'invalid-signature':
    case 'unknown-kid':
    case 'alg-not-allowed':
    case 'alg-none':
      return 'invalid_key';
    case 'wrong-issuer':
      return 'invalid_issuer';
    case 'wrong-audience':
      return 'invalid_audience';
    case 'expired':
    case 'not-yet-valid':
    case 'wrong-token-type':
    case 'malformed':
    case 'encrypted-token':
    case 'dpop-proof-invalid':
    case 'mtls-binding-mismatch':
    case 'sender-constraint-required':
    case 'token-in-query':
    case 'invalid-claims':
    case 'jwks-unavailable':
    case 'discovery-unavailable':
    case 'discovery-mismatch':
      return 'invalid_request';
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contentType(request: Request): string {
  const raw = request.headers.get('content-type') ?? '';
  return raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function parseEvery(every: number | string): number {
  if (typeof every === 'number') {
    if (!Number.isFinite(every) || every <= 0) {
      throw new TypeError('PermDock: poll every must be a positive interval.');
    }
    return every;
  }
  const match = /^(\d+)(ms|s|m)$/u.exec(every);
  if (match === null || match[2] === undefined) {
    throw new TypeError(`PermDock: invalid poll interval '${every}'.`);
  }
  const n = Number(match[1]);
  const unit = match[2];
  if (unit !== 'ms' && unit !== 's' && unit !== 'm') {
    throw new TypeError(`PermDock: invalid poll interval '${every}'.`);
  }
  switch (unit) {
    case 'ms':
      return n;
    case 's':
      return n * 1000;
    case 'm':
      return n * 60_000;
    default: {
      const exhaustive: never = unit;
      return exhaustive;
    }
  }
}

function asSubject(
  mapped: string | SsfSubject,
  session: string | undefined,
  issuer: string | undefined,
): SsfSubject {
  if (typeof mapped === 'string') {
    return compact({ id: mapped, session, issuer });
  }
  return compact({
    id: mapped.id,
    session: mapped.session ?? session,
    issuer: mapped.issuer ?? issuer,
  });
}

function setSubjectFromClaims(claims: JwtClaims): SetSubject | undefined {
  const subId = claims.sub_id;
  if (isRecord(subId) && typeof subId.format === 'string') {
    return subId as SetSubject;
  }
  if (typeof claims.sub === 'string' && claims.sub.length > 0) {
    return compact({
      format: 'iss_sub',
      iss: typeof claims.iss === 'string' ? claims.iss : undefined,
      sub: claims.sub,
    });
  }
  return undefined;
}

function eventTimestamp(
  payload: Readonly<Record<string, unknown>>,
): number | undefined {
  const value = payload.event_timestamp;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function eventSession(
  payload: Readonly<Record<string, unknown>>,
): string | undefined {
  if (typeof payload.session === 'string' && payload.session.length > 0) {
    return payload.session;
  }
  if (typeof payload.sid === 'string' && payload.sid.length > 0) {
    return payload.sid;
  }
  return undefined;
}

export function createReceiver(config: ReceiverConfig): SsfReceiver {
  const listeners = new Set<SsfEventListener>();

  function emit(event: object): void {
    const next = compact<SsfAuditEvent>(event);
    for (const listener of listeners) {
      listener(next);
    }
  }

  async function verify(
    token: string,
    typ: string,
  ): Promise<VerifiedToken | IngestFail> {
    const result = await config.verifier.verify(
      token,
      compact({
        typ,
        issuer: config.issuer,
        audience: config.audience,
        clockTolerance: config.clockTolerance,
      }),
    );
    if (!result.ok) {
      return {
        ok: false,
        err: errForCause(result.cause),
        description: result.cause,
        cause: result.cause,
      };
    }
    if (
      typeof result.claims.jti !== 'string' ||
      result.claims.jti.length === 0
    ) {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'missing jti',
        cause: 'invalid-claims',
      };
    }
    if (typeof result.claims.iat !== 'number') {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'missing iat',
        cause: 'invalid-claims',
      };
    }
    return result;
  }

  async function resolveSubject(
    setSubject: SetSubject,
    session: string | undefined,
    issuer: string | undefined,
  ): Promise<SsfSubject | undefined> {
    const mapped = await config.subject(
      setSubject,
      compact({ session, issuer }),
    );
    if (mapped === null || mapped === undefined) {
      return undefined;
    }
    if (typeof mapped === 'string' && mapped.length === 0) {
      return undefined;
    }
    if (typeof mapped !== 'string' && mapped.id.length === 0) {
      return undefined;
    }
    return asSubject(mapped, session, issuer);
  }

  async function dispatch(
    type: string,
    input: SsfEventInput,
  ): Promise<IngestResult> {
    const named = config.onEvent[type as keyof SsfOnEvent];
    const wildcard = config.onEvent['*'];
    const handler: SsfEventHandler | undefined = named ?? wildcard;
    if (handler === undefined) {
      emit({
        type,
        subject: input.subject,
        transmitter: input.subject.issuer,
        jti: input.jti,
        unknown: 'event',
      });
      return { ok: true };
    }
    try {
      await handler(input);
    } catch {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'handler failed',
      };
    }
    emit({
      type,
      subject: input.subject,
      transmitter: input.subject.issuer,
      jti: input.jti,
    });
    return { ok: true };
  }

  async function dispatchEvents(
    entries: readonly (readonly [string, unknown])[],
    issuer: string | undefined,
    jti: string,
    baseSubject: SetSubject | undefined,
  ): Promise<IngestResult> {
    const [head, ...tail] = entries;
    if (head === undefined) {
      return { ok: true };
    }
    const [uri, raw] = head;
    const payload = isRecord(raw) ? raw : {};
    const type = caepName(uri) ?? uri;
    const session = eventSession(payload);
    if (caepName(uri) === undefined && config.onEvent['*'] === undefined) {
      emit({
        type,
        transmitter: issuer,
        jti,
        unknown: 'event',
      });
      return dispatchEvents(tail, issuer, jti, baseSubject);
    }
    const identifier = baseSubject ?? {
      format: 'opaque',
      id: session ?? jti,
    };
    const subject = await resolveSubject(identifier, session, issuer);
    if (subject === undefined) {
      emit({
        type,
        transmitter: issuer,
        jti,
        unknown: 'subject',
      });
      return dispatchEvents(tail, issuer, jti, baseSubject);
    }
    const result = await dispatch(
      type,
      compact({
        subject,
        event: payload,
        event_timestamp: eventTimestamp(payload),
        jti,
        type,
      }),
    );
    if (!result.ok) {
      return result;
    }
    return dispatchEvents(tail, issuer, jti, baseSubject);
  }

  async function ingestSet(token: string): Promise<IngestResult> {
    const verified = await verify(token, SET_TYP);
    if (!verified.ok) {
      emit({
        type: 'verification-failed',
        err: verified.err,
        cause: verified.cause,
      });
      return verified;
    }
    const jti = verified.claims.jti as string;
    if (await config.replay.seen(jti)) {
      emit({
        type: 'replay',
        transmitter:
          typeof verified.claims.iss === 'string'
            ? verified.claims.iss
            : undefined,
        jti,
        replayed: true,
      });
      return { ok: true };
    }
    const events = verified.claims.events;
    if (!isRecord(events)) {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'missing events',
        cause: 'invalid-claims',
      };
    }
    const issuer =
      typeof verified.claims.iss === 'string' ? verified.claims.iss : undefined;
    const baseSubject = setSubjectFromClaims(verified.claims);
    const dispatched = await dispatchEvents(
      Object.entries(events),
      issuer,
      jti,
      baseSubject,
    );
    if (!dispatched.ok) {
      return dispatched;
    }
    await config.replay.remember(jti);
    return { ok: true };
  }

  async function ingestLogout(token: string): Promise<IngestResult> {
    const verified = await verify(token, LOGOUT_TYP);
    if (!verified.ok) {
      emit({
        type: 'verification-failed',
        err: verified.err,
        cause: verified.cause,
      });
      return {
        ok: false,
        err: 'invalid_request',
        description: verified.description,
      };
    }
    if (verified.claims.nonce !== undefined) {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'nonce must be absent',
        cause: 'invalid-claims',
      };
    }
    const events = verified.claims.events;
    if (!isRecord(events) || !(BACKCHANNEL_LOGOUT_EVENT in events)) {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'missing backchannel-logout event',
        cause: 'invalid-claims',
      };
    }
    const sub =
      typeof verified.claims.sub === 'string' ? verified.claims.sub : undefined;
    const sid =
      typeof verified.claims.sid === 'string' ? verified.claims.sid : undefined;
    if (
      (sub === undefined || sub.length === 0) &&
      (sid === undefined || sid.length === 0)
    ) {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'sub or sid required',
        cause: 'invalid-claims',
      };
    }
    const jti = verified.claims.jti as string;
    if (await config.replay.seen(jti)) {
      emit({
        type: 'replay',
        jti,
        replayed: true,
      });
      return { ok: true };
    }
    const issuer =
      typeof verified.claims.iss === 'string' ? verified.claims.iss : undefined;
    const identifier: SetSubject =
      sub === undefined
        ? compact({ format: 'opaque', id: sid })
        : compact({ format: 'iss_sub', iss: issuer, sub });
    const subject = await resolveSubject(identifier, sid, issuer);
    if (subject === undefined) {
      emit({
        type: 'session-revoked',
        transmitter: issuer,
        jti,
        unknown: 'subject',
      });
      await config.replay.remember(jti);
      return { ok: true };
    }
    const payload = isRecord(events[BACKCHANNEL_LOGOUT_EVENT])
      ? events[BACKCHANNEL_LOGOUT_EVENT]
      : {};
    const dispatched = await dispatch(
      'session-revoked',
      compact({
        subject,
        event: payload,
        event_timestamp: eventTimestamp(payload),
        jti,
        type: 'session-revoked',
      }),
    );
    if (!dispatched.ok) {
      return dispatched;
    }
    await config.replay.remember(jti);
    return { ok: true };
  }

  async function pollOnce(
    options: PollOptions,
    acks: readonly string[],
  ): Promise<readonly string[]> {
    const fetchFn = options.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }
    const body: Record<string, unknown> = {
      maxEvents: 100,
      returnImmediately: true,
    };
    if (acks.length > 0) {
      body.acks = acks;
    }
    const requestInit = compact<RequestInit>({
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    const response = await fetchFn(options.endpoint, requestInit);
    if (!response.ok) {
      emit({ type: 'poll-failed', err: 'connection_failed' });
      return [];
    }
    const parsed: unknown = await response.json();
    if (!isRecord(parsed) || !isRecord(parsed.sets)) {
      return [];
    }
    const tokens = Object.entries(parsed.sets).flatMap(([jti, jwt]) =>
      typeof jwt === 'string' ? [{ jti, jwt }] : [],
    );
    const outcomes = await Promise.all(
      tokens.map(async ({ jti, jwt }) => ({
        jti,
        ok: (await ingestSet(jwt)).ok,
      })),
    );
    const processed = outcomes.flatMap((row) => (row.ok ? [row.jti] : []));
    if (processed.length > 0) {
      await fetchFn(
        options.endpoint,
        compact<RequestInit>({
          method: 'POST',
          headers,
          body: JSON.stringify({
            acks: processed,
            maxEvents: 0,
            returnImmediately: true,
          }),
          signal: options.signal,
        }),
      );
    }
    return processed;
  }

  const receiver: SsfReceiver = {
    async push(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return rfc8935(400, 'invalid_request', 'POST required');
      }
      if (contentType(request) !== SET_CONTENT) {
        return rfc8935(
          400,
          'invalid_request',
          'application/secevent+jwt required',
        );
      }
      const token = (await request.text()).trim();
      if (token.length === 0) {
        return rfc8935(400, 'invalid_request', 'empty body');
      }
      const result = await ingestSet(token);
      if (!result.ok) {
        return rfc8935(400, result.err, result.description);
      }
      return new Response(null, { status: 202 });
    },

    async logout(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return jsonResponse(400, { error: 'invalid_request' });
      }
      if (contentType(request) !== LOGOUT_CONTENT) {
        return jsonResponse(400, { error: 'invalid_request' });
      }
      const params = new URLSearchParams(await request.text());
      const token = params.get('logout_token');
      if (token === null || token.length === 0) {
        return jsonResponse(400, { error: 'invalid_request' });
      }
      const result = await ingestLogout(token);
      if (!result.ok) {
        return jsonResponse(400, { error: 'invalid_request' });
      }
      return new Response(null, { status: 200 });
    },

    poll(options: PollOptions): Promise<PollResult> | PollHandle {
      if (options.every === undefined) {
        return pollOnce(options, []).then((acked) => ({ acked }));
      }
      const ms = parseEvery(options.every);
      let timer: ReturnType<typeof setInterval> | undefined;
      const tick = (): void => {
        void pollOnce(options, []).catch(() => {
          emit({ type: 'poll-failed', err: 'connection_failed' });
        });
      };
      tick();
      timer = setInterval(tick, ms);
      return {
        stop(): void {
          if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
        },
      };
    },

    on(event: 'event', handler: SsfEventListener): () => void {
      if (event !== 'event') {
        const exhaustive: never = event;
        return exhaustive;
      }
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
  return receiver;
}
