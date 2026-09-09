import { r as Permission } from "./permissions-CkmCCiYs.js";
import { n as Decision } from "./decision-CH_azeep.js";
import { f as SnapshotV2 } from "./interfaces-BPpihPRB.js";
import { c as PermissionState, r as ClientPermDock } from "./types-CkGVMhxm.js";
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