---
"permdock": minor
---

The connector-v1 `siem` kind takes an optional `config.headers` map for the collector credential (Splunk HEC `Authorization`, Datadog `DD-API-KEY`), so the credential never sits in the endpoint URL. This is an additive v1 change: every body that was valid stays valid, and a validator built from the earlier `connector-v1.json` rejects `headers`. A store seals header values and lists only their names.
