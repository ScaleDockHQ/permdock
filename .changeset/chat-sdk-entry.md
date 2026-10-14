---
"permdock": minor
---

New `permdock/chat-sdk` entry, with `chat` 4 as an optional peer. `chatSdkAuthor` turns a Chat SDK `Author` into a `ChatAuthor`, and is `null` for bots. `chatSdkTransport` is the chat channel of `permdock/delivery` and posts direct messages. `approvalCard` renders an approval prompt with a link to the approval page. `approvalActions` applies its approve and reject buttons as the clicking user through `ChatPermDock.resolveAction`.
