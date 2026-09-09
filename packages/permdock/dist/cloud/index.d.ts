import { k as SnapshotSource, y as DecisionSink } from "../policy-btMlTuxm.js";
import { s as ApprovalStore } from "../types-D19MSDwi.js";
//#region src/cloud/types.d.ts
type CloudOptions = {
  readonly url?: string;
  readonly key?: string;
  readonly environment?: string;
  readonly fetch?: typeof fetch;
  readonly flushAt?: number;
  readonly waitUntil?: (task: Promise<void>) => void;
};
type CloudClient = {
  readonly approvals: ApprovalStore;
  readonly sink: DecisionSink;
  readonly snapshots: SnapshotSource;
};
//#endregion
//#region src/cloud/create.d.ts
export declare function cloud(options?: CloudOptions): CloudClient;
//#endregion
export type { CloudClient, CloudOptions };