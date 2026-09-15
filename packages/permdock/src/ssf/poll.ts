import type { PollOptions, SsfAuditEvent } from './types.ts';

import { compact } from '../core/compact.ts';
import { isRecord, type IngestResult } from './wire.ts';

/**
 * One RFC 8936 poll round: fetch the pending SETs, ingest them and acknowledge
 * the ones that were accepted. Returns the acknowledged `jti` values.
 */
export async function pollOnce(input: {
  readonly options: PollOptions;
  readonly acks: readonly string[];
  readonly ingest: (token: string) => Promise<IngestResult>;
  readonly emit: (event: SsfAuditEvent) => void;
}): Promise<readonly string[]> {
  const { options, acks, ingest, emit } = input;
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
      ok: (await ingest(jwt)).ok,
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
