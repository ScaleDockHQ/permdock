---
'permdock': patch
---

`permdock/terminal`: a network failure during the device flow now ends the `device` token source with no credential, so the chain moves on to the next source, the same as a failed refresh or revocation. Before, the thrown `fetch` error escaped the command.
