import * as SecureStore from "expo-secure-store";
import { memoryStorage, type PermDockStorage } from "permdock/react-native";
import { Platform } from "react-native";

// expo-secure-store has no web implementation; the web build keeps the snapshot in memory.
export const storage: PermDockStorage =
  Platform.OS === "web"
    ? memoryStorage()
    : {
        getItem: (key) => SecureStore.getItem(key),
        setItem: (key, value) => {
          SecureStore.setItem(key, value);
        },
        removeItem: async (key) => {
          await SecureStore.deleteItemAsync(key);
        },
      };
