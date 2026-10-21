import type { PollSetsOptions } from "./poll-client.ts";
import type { PollOptions, SetError, SsfAuditEvent } from "./types.ts";
import type { IngestResult } from "./wire.ts";

import { compact } from "../core/compact.ts";
import { pollSets } from "./poll-client.ts";

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
  const transport = compact<PollSetsOptions>({
    endpoint: options.endpoint,
    authorization:
      options.token === undefined ? undefined : `Bearer ${options.token}`,
    fetch: options.fetch,
    signal: options.signal,
  });
  const polled = await pollSets({ ...transport, acks });
  if (!polled.ok) {
    emit({ type: "poll-failed", err: "connection_failed" });
    return [];
  }
  const outcomes = await Promise.all(
    polled.sets.map(async ({ jti, set }) => ({
      jti,
      result: await ingest(set),
    })),
  );
  const processed = outcomes.flatMap((row) => (row.result.ok ? [row.jti] : []));
  // RFC 8936 section 2.4: a SET that can never verify is reported, not acked;
  // a failed handler (no cause) is left pending so the transmitter retries.
  const setErrs: Record<string, SetError> = {};
  for (const { jti, result } of outcomes) {
    if (!result.ok && result.cause !== undefined) {
      setErrs[jti] = { err: result.err, description: result.description };
    }
  }
  if (processed.length > 0 || Object.keys(setErrs).length > 0) {
    await pollSets({ ...transport, acks: processed, setErrs, maxEvents: 0 });
  }
  return processed;
}
