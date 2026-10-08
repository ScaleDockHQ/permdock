---
"permdock": minor
---

`permdock/react-native` adds `secureStoreStorage(SecureStore)`, which splits values into 2048-byte chunks, and the synchronous `mmkvStorage(mmkv)`. It also adds `appStateForeground(AppState)` and `netInfoOnline(NetInfo)` for the provider's `subscribeForeground` and `subscribeOnline`. `useSnapshotReady()` is for the splash screen, `usePermissionGuard(permission | permission[], data?)` is for `Stack.Protected` and `Tabs.Protected`, and the type guard `parseLocalSnapshotManifest(value)` is also exported from `permdock`. A `source` is read again on each return to the foreground.
