---
"permdock": minor
---

`permdock/delivery` exports `parseConnector(input)`, which checks a PermDock Cloud connector body against `connector-v1.json` and answers a frozen `ConnectorV1` or a list of issues, each with a JSON pointer `path`. `CONNECTOR_KINDS` and `CONNECTOR_SCHEMA` are exported too.
