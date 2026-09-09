import { v as Permission } from "./policy-DsqYfECx.js";
import { n as Decision } from "./decision-C6A-71_M.js";
import { f as SnapshotV2 } from "./interfaces-B19qT0zU.js";
import { c as PermissionState, r as ClientPermDock } from "./types-DN9PS-Hn.js";
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