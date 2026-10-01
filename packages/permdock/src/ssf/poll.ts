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
    headers['authorization'] = `Bearer ${options.token}`;
  }
  const body: Record<string, unknown> = {
    maxEvents: 100,
    returnImmediately: true,
  };
  if (acks.length > 0) {
    body['acks'] = acks;
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
  if (!isRecord(parsed) || !isRecord(parsed['sets'])) {
    return [];
  }
  const tokens = Object.entries(parsed['sets']).flatMap(([jti, jwt]) =>
    typeof jwt === 'string' ? [{ jti, jwt }] : [],
  );
  const outcomes = await Promise.all(
    tokens.map(async ({ jti, jwt }) => ({ jti, result: await ingest(jwt) })),
  );
  const processed = outcomes.flatMap((row) => (row.result.ok ? [row.jti] : []));
  // RFC 8936 section 2.4: a SET that can never verify is reported, not acked;
  // a failed handler (no cause) is left pending so the transmitter retries.
  const setErrs: Record<string, { err: string; description: string }> = {};
  for (const { jti, result } of outcomes) {
    if (!result.ok && result.cause !== undefined) {
      setErrs[jti] = { err: result.err, description: result.description };
    }
  }
  const failed = Object.keys(setErrs).length;
  if (processed.length > 0 || failed > 0) {
    await fetchFn(
      options.endpoint,
      compact<RequestInit>({
        method: 'POST',
        headers,
        body: JSON.stringify(
          compact({
            acks: processed,
            setErrs: failed > 0 ? setErrs : undefined,
            maxEvents: 0,
            returnImmediately: true,
          }),
        ),
        signal: options.signal,
      }),
    );
  }
  return processed;
}
