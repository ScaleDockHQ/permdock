import type { SsfStreamConfiguration, SsfStreamStatus } from "./types.ts";

/** One stream a transmitter holds and the receiver that created it. */
export type SsfStream = {
  /**
   * The receiver `ssfTransmitter`'s `authorize` answered when the stream was
   * created.
   */
  readonly owner: string;
  readonly configuration: SsfStreamConfiguration;
};

/**
 * The streams an SSF 1.0 transmitter serves (section 8.1). A new stream is
 * `enabled`; `status` answers `null` for a stream that does not exist.
 */
export type SsfStreamStore = {
  /** Names the implementation in errors and events. */
  readonly name?: string;
  create(
    owner: string,
    configuration: SsfStreamConfiguration,
  ): void | Promise<void>;
  get(streamId: string): SsfStream | null | Promise<SsfStream | null>;
  /**
   * Every stream of `owner`, or every stream when `owner` is absent, oldest
   * first.
   */
  list(owner?: string): readonly SsfStream[] | Promise<readonly SsfStream[]>;
  /**
   * Replaces the configuration of the stream `configuration.stream_id`; the
   * owner and status stay.
   */
  update(configuration: SsfStreamConfiguration): void | Promise<void>;
  delete(streamId: string): void | Promise<void>;
  status(
    streamId: string,
  ): SsfStreamStatus | null | Promise<SsfStreamStatus | null>;
  setStatus(status: SsfStreamStatus): void | Promise<void>;
};

type Entry = { readonly stream: SsfStream; readonly status: SsfStreamStatus };

/**
 * An in-process `SsfStreamStore`. A process restart loses every stream; a
 * deployment with more than one instance needs a shared store.
 */
export function memorySsfStreamStore(): SsfStreamStore {
  const entries = new Map<string, Entry>();
  return Object.freeze({
    name: "memory",
    create(owner: string, configuration: SsfStreamConfiguration): void {
      const id = configuration.stream_id;
      entries.set(id, {
        stream: Object.freeze({ owner, configuration }),
        status: Object.freeze({ stream_id: id, status: "enabled" }),
      });
    },
    get(streamId: string): SsfStream | null {
      return entries.get(streamId)?.stream ?? null;
    },
    list(owner?: string): readonly SsfStream[] {
      return [...entries.values()]
        .map((entry) => entry.stream)
        .filter((stream) => owner === undefined || stream.owner === owner);
    },
    update(configuration: SsfStreamConfiguration): void {
      const entry = entries.get(configuration.stream_id);
      if (entry !== undefined) {
        entries.set(configuration.stream_id, {
          stream: Object.freeze({ owner: entry.stream.owner, configuration }),
          status: entry.status,
        });
      }
    },
    delete(streamId: string): void {
      entries.delete(streamId);
    },
    status(streamId: string): SsfStreamStatus | null {
      return entries.get(streamId)?.status ?? null;
    },
    setStatus(status: SsfStreamStatus): void {
      const entry = entries.get(status.stream_id);
      if (entry !== undefined) {
        entries.set(status.stream_id, {
          stream: entry.stream,
          status: Object.freeze({ ...status }),
        });
      }
    },
  });
}
