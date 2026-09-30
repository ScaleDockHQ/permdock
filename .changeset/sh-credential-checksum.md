---
'permdock': minor
---

API keys end in a 6-character base62 CRC-32 checksum: `pdk_<id>_<secret><checksum>`. `generateApiKey` appends it and `parseApiKey` rejects a key whose checksum does not match, so secret scanners can match `pdk_[A-Za-z0-9_-]{1,128}_[A-Za-z0-9]{49}` and discard lookalikes offline; keys generated before this change no longer parse. `CredentialVerifier` gains an optional `touch(id, at)` that `subjectFromApiKey` calls, without awaiting, after a key resolves, for a `lastUsedAt` column; `apiKeyVerifier({ find, touch })` passes it through, `memoryCredentials()` records it (`lastUsedAt(id)`), and `testCredentialVerifier` checks that a touch never changes what a key verifies to.
