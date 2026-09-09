import { A as SnapshotV2, B as Decision, J as Permission } from "./policy-btMlTuxm.js";
import { c as PermissionState, r as ClientPermDock } from "./types-D4Vi3oam.js";
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