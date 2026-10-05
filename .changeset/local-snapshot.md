---
"permdock": minor
---

`localSnapshot({ manifest, read, subscribe })` in `permdock/react-native` builds the snapshot from the device's own membership and custom-role rows, and the provider takes it as `source`. `localSnapshotManifest(policy)` from `permdock` writes the JSON manifest at build time, so the policy never ships to the app.
