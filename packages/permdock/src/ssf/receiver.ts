import type { ApprovalStore } from '../approvals/types.ts';
import type { TokenVerifier, VerifiedToken } from '../core/interfaces.ts';
import type { RevocationFeed } from '../core/revocations.ts';
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

import { cancelApprovals } from '../approvals/helpers.ts';
import { compact } from '../core/compact.ts';
import {
  asSubject,
  eventSession,
  eventSubject,
  eventTimestamp,
  setSubjectFromClaims,
  subjectSession,
} from './claims.ts';
import { BACKCHANNEL_LOGOUT_EVENT, caepName } from './events.ts';
import { pollOnce } from './poll.ts';
import {
  LOGOUT_CONTENT,
  LOGOUT_TYP,
  SET_CONTENT,
  SET_TYP,
  contentType,
  errForCause,
  isRecord,
  jsonResponse,
  parseEvery,
  rfc8935,
  type IngestFail,
  type IngestResult,
} from './wire.ts';

type ReceiverConfig = {
  readonly verifier: TokenVerifier;
  readonly issuer?: string;
  readonly audience: string | readonly string[];
  readonly subject: SsfSubjectMapper;
  readonly onEvent: SsfOnEvent;
  readonly replay: ReplayStore;
  readonly approvals?: ApprovalStore;
  readonly revocations?: RevocationFeed;
  readonly clockTolerance?: number;
};

const CHANGED_EVENTS: ReadonlySet<string> = new Set([
  'credential-change',
  'assurance-level-change',
  'token-claims-change',
]);

function replayExpiresAt(
  claims: Readonly<Record<string, unknown>>,
  clockTolerance = 0,
): number | undefined {
  if (typeof claims['exp'] === 'number') {
    return claims['exp'];
  }
  if (typeof claims['iat'] === 'number') {
    const until = claims['iat'] + clockTolerance;
    return until > Date.now() / 1000 ? until : undefined;
  }
  return undefined;
}

type DeliveryRun = {
  readonly issuer: string | undefined;
  readonly jti: string;
  readonly baseSubject: SetSubject | undefined;
  readonly expiresAt: number | undefined;
  /** Record each event that succeeded, so a retried SET skips it. */
  readonly perEvent: boolean;
};

function replayKey(
  issuer: string | undefined,
  jti: string,
  event?: string,
): string {
  return JSON.stringify(
    event === undefined ? [issuer ?? null, jti] : [issuer ?? null, jti, event],
  );
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
      typeof result.claims['jti'] !== 'string' ||
      result.claims['jti'].length === 0
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

  const atomic =
    typeof config.replay.claim === 'function' &&
    typeof config.replay.release === 'function';

  /** `true` when this delivery owns the SET and should dispatch it. */
  async function claimDelivery(
    key: string,
    expiresAt: number | undefined,
  ): Promise<boolean> {
    if (atomic) {
      return (await config.replay.claim?.(key, expiresAt)) === true;
    }
    return !(await config.replay.seen(key));
  }

  async function settleDelivery(
    key: string,
    expiresAt: number | undefined,
    ok: boolean,
  ): Promise<void> {
    if (atomic) {
      if (!ok) {
        await config.replay.release?.(key);
      }
      return;
    }
    if (ok) {
      await config.replay.remember(key, expiresAt);
    }
  }

  async function publishRevocation(input: SsfEventInput): Promise<void> {
    const feed = config.revocations;
    if (feed === undefined) {
      return;
    }
    const kind =
      input.type === 'session-revoked'
        ? 'session-revoked'
        : CHANGED_EVENTS.has(input.type)
          ? 'changed'
          : undefined;
    if (kind === undefined) {
      return;
    }
    try {
      await feed.revoke(
        compact({
          principal: input.subject.id,
          session:
            kind === 'session-revoked' ? input.subject.session : undefined,
          kind,
        }),
      );
    } catch {
      // Connections fall back to their expiry when a feed is down.
    }
  }

  async function cancelSessionApprovals(input: SsfEventInput): Promise<void> {
    if (config.approvals === undefined || input.type !== 'session-revoked') {
      return;
    }
    const count = await cancelApprovals(
      config.approvals,
      compact({
        principalId: input.subject.id,
        session: input.subject.session,
      }),
      { by: 'ssf', note: input.jti },
    );
    emit({
      type: 'approvals-cancelled',
      subject: input.subject,
      jti: input.jti,
      cancelled: count,
    });
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
      await publishRevocation(input);
      await cancelSessionApprovals(input);
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
    await publishRevocation(input);
    await cancelSessionApprovals(input);
    return { ok: true };
  }

  async function dispatchEvents(
    entries: readonly (readonly [string, unknown])[],
    run: DeliveryRun,
  ): Promise<IngestResult> {
    const [head, ...tail] = entries;
    if (head === undefined) {
      return { ok: true };
    }
    const { issuer, jti, baseSubject } = run;
    const [uri, raw] = head;
    const eventKey = replayKey(issuer, jti, uri);
    if (run.perEvent && (await config.replay.seen(eventKey))) {
      return dispatchEvents(tail, run);
    }
    const payload = isRecord(raw) ? raw : {};
    const type = caepName(uri) ?? uri;
    if (caepName(uri) === undefined && config.onEvent['*'] === undefined) {
      emit({
        type,
        transmitter: issuer,
        jti,
        unknown: 'event',
      });
      return dispatchEvents(tail, run);
    }
    const identifier = baseSubject ??
      eventSubject(payload) ?? {
        format: 'opaque',
        id: eventSession(payload) ?? jti,
      };
    const session = eventSession(payload) ?? subjectSession(identifier);
    const subject = await resolveSubject(identifier, session, issuer);
    if (subject === undefined) {
      emit({
        type,
        transmitter: issuer,
        jti,
        unknown: 'subject',
      });
      return dispatchEvents(tail, run);
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
    if (run.perEvent) {
      await config.replay.remember(eventKey, run.expiresAt);
    }
    return dispatchEvents(tail, run);
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
    const jti = verified.claims['jti'] as string;
    const issuer =
      typeof verified.claims.iss === 'string' ? verified.claims.iss : undefined;
    const events = verified.claims['events'];
    if (!isRecord(events)) {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'missing events',
        cause: 'invalid-claims',
      };
    }
    const key = replayKey(issuer, jti);
    const expiresAt = replayExpiresAt(verified.claims, config.clockTolerance);
    if (!(await claimDelivery(key, expiresAt))) {
      emit({ type: 'replay', transmitter: issuer, jti, replayed: true });
      return { ok: true };
    }
    const entries = Object.entries(events);
    let dispatched: IngestResult = {
      ok: false,
      err: 'invalid_request',
      description: 'handler failed',
    };
    try {
      dispatched = await dispatchEvents(entries, {
        issuer,
        jti,
        baseSubject: setSubjectFromClaims(verified.claims),
        expiresAt,
        perEvent: entries.length > 1,
      });
    } finally {
      await settleDelivery(key, expiresAt, dispatched.ok);
    }
    return dispatched;
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
    if (verified.claims['nonce'] !== undefined) {
      return {
        ok: false,
        err: 'invalid_request',
        description: 'nonce must be absent',
        cause: 'invalid-claims',
      };
    }
    const events = verified.claims['events'];
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
      typeof verified.claims['sid'] === 'string'
        ? verified.claims['sid']
        : undefined;
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
    const jti = verified.claims['jti'] as string;
    const issuer =
      typeof verified.claims.iss === 'string' ? verified.claims.iss : undefined;
    const key = replayKey(issuer, jti);
    const expiresAt = replayExpiresAt(verified.claims, config.clockTolerance);
    if (!(await claimDelivery(key, expiresAt))) {
      emit({ type: 'replay', transmitter: issuer, jti, replayed: true });
      return { ok: true };
    }
    let dispatched: IngestResult = {
      ok: false,
      err: 'invalid_request',
      description: 'handler failed',
    };
    try {
      dispatched = await dispatchLogout(verified.claims, {
        issuer,
        jti,
        sub,
        sid,
      });
    } finally {
      await settleDelivery(key, expiresAt, dispatched.ok);
    }
    return dispatched;
  }

  async function dispatchLogout(
    claims: Readonly<Record<string, unknown>>,
    ids: {
      readonly issuer: string | undefined;
      readonly jti: string;
      readonly sub: string | undefined;
      readonly sid: string | undefined;
    },
  ): Promise<IngestResult> {
    const { issuer, jti, sub, sid } = ids;
    const events = claims['events'] as Readonly<Record<string, unknown>>;
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
      return { ok: true };
    }
    const payload = isRecord(events[BACKCHANNEL_LOGOUT_EVENT])
      ? events[BACKCHANNEL_LOGOUT_EVENT]
      : {};
    return dispatch(
      'session-revoked',
      compact({
        subject,
        event: payload,
        event_timestamp: eventTimestamp(payload),
        jti,
        type: 'session-revoked',
      }),
    );
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
        return pollOnce({ options, acks: [], ingest: ingestSet, emit }).then(
          (acked) => ({ acked }),
        );
      }
      const ms = parseEvery(options.every);
      let timer: ReturnType<typeof setInterval> | undefined;
      const tick = (): void => {
        void pollOnce({ options, acks: [], ingest: ingestSet, emit }).catch(
          () => {
            emit({ type: 'poll-failed', err: 'connection_failed' });
          },
        );
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
