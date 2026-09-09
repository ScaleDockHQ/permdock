import { v as Permission } from "./policy-Ypk6zTSJ.js";
import { n as Decision } from "./decision-BD0W6Opj.js";
import { f as SnapshotV2 } from "./interfaces-BPpihPRB.js";
import { c as PermissionState, r as ClientPermDock } from "./types-DIMCGXJs.js";
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