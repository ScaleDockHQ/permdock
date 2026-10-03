# 0015. Ask AI input built from `InputGroup`

- Status: accepted
- Date: 2026-09-30

## Context

The standard builds chat UIs from AI Elements. Its `prompt-input` component is typed against Radix and does not compile against the Base UI primitives in `packages/ui`.

## Decision

`/docs/ask` uses the AI Elements `conversation` and `message` components. The input is `InputGroup`, `InputGroupTextarea` and `InputGroupButton` from `packages/ui`. `prompt-input` is not vendored.

## Consequences

The input has no attachments or model picker, which Ask AI does not need. Revisit when AI Elements ships a Base UI variant.

## Alternatives considered

- Porting `prompt-input` to Base UI by hand: every AI Elements update becomes a merge.
- Vendoring Radix for one component: two primitive libraries in the docs bundle.
