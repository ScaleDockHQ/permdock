import type { LocalSnapshotManifest } from "permdock";
import type {
  LocalSnapshotData,
  LocalSnapshotOptions,
} from "permdock/react-native";

import { localSnapshotManifest } from "permdock";
import { buildLocalSnapshot } from "permdock/react-native";

import { jobPolicy } from "./levels.js";

export const manifest: LocalSnapshotManifest = localSnapshotManifest(jobPolicy);

const data: LocalSnapshotData = {
  principal: {
    id: "u1",
    tenant: "acme",
    memberships: [{ scope: "tenant", id: "acme", roles: ["admin"] }],
    attributes: { teamIds: ["t1"] },
  },
  customRoles: [
    {
      tenant: "acme",
      name: "dispatcher",
      grants: [{ permission: "job.read", level: "team" }],
    },
  ],
};

export const options: LocalSnapshotOptions = {
  manifest,
  read: async () => data,
  subscribe: (listener) => {
    const timer = setInterval(listener, 1000);
    return () => {
      clearInterval(timer);
    };
  },
};

export const roles: readonly string[] = buildLocalSnapshot(
  manifest,
  data,
).roles;
