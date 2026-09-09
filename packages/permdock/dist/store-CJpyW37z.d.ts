import { A as SnapshotV2, B as Decision, J as Permission } from "./policy-B9ZJilUm.js";
import { c as PermissionState, r as ClientPermDock } from "./types-BkASnC6E.js";
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