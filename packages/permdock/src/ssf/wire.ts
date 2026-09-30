import type { TokenFailureCause } from '../core/interfaces.ts';

export const SET_TYP = 'secevent+jwt';
export const LOGOUT_TYP = 'logout+jwt';
export const SET_CONTENT = 'application/secevent+jwt';
export const LOGOUT_CONTENT = 'application/x-www-form-urlencoded';

export type IngestOk = { readonly ok: true };
export type IngestFail = {
  readonly ok: false;
  readonly err: string;
  readonly description: string;
  readonly cause?: TokenFailureCause;
};
export type IngestResult = IngestOk | IngestFail;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function rfc8935(
  status: number,
  err: string,
  description: string,
): Response {
  return jsonResponse(status, { err, description });
}

export function errForCause(cause: TokenFailureCause): string {
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
    case 'invalid-chain':
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function contentType(request: Request): string {
  const raw = request.headers.get('content-type') ?? '';
  return raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function parseEvery(every: number | string): number {
  if (typeof every === 'number') {
    if (!Number.isFinite(every) || every <= 0) {
      throw new TypeError('PermDock: poll every must be a positive interval.');
    }
    return every;
  }
  const match = /^(\d+)(ms|s|m)$/u.exec(every);
  if (match?.[2] === undefined) {
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
