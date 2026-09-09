import { K as Permission, O as SnapshotV2, R as Decision } from "./policy-DdqgAkJT.js";
import { c as PermissionState, r as ClientPermDock } from "./types-DrPUgCD4.js";
//#region src/react/store.d.ts
type ClientStore = {
  get(): ClientPermDock;
  subscribe(listener: () => void): () => void;
  permissionState(permission: Permission, data?: unknown): PermissionState;
  requestApproval(decision: Decision, note?: string): Promise<void>;
  replace(value: unknown): void;
  snapshot(): SnapshotV2;
};
//#endregion
export { ClientStore as t };