import {
  nativeStore,
  memorySnapshotStorage,
} from "../../src/react-native/index.ts";
import { testClientStore } from "../../src/testing/client-store.ts";

testClientStore("permdock/react-native nativeStore", (options) =>
  nativeStore({
    ...options,
    storage: memorySnapshotStorage(),
    subjectId: null,
  }),
);
