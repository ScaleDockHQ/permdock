import {
  createNativeStore,
  memoryStorage,
} from "../../src/react-native/index.ts";
import { testClientStore } from "../../src/testing/client-store.ts";

testClientStore("permdock/react-native createNativeStore", (options) =>
  createNativeStore({ ...options, storage: memoryStorage(), subjectId: null }),
);
