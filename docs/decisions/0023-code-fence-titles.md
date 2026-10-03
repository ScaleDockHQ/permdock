# 0023. Code fences need a language, not a title

- Status: accepted
- Date: 2026-10-03

## Context

The standard asks that fenced code has a language and a `title`. Of the 446 fences in `apps/docs/content/docs`, one has a title. Most are shell commands or snippets that sit inside a file the surrounding text already names, so there is no file path to put in a title.

## Decision

Every fence has a language. A fence gets a `title` only when it shows a whole file at a fixed path, such as `permdock.config.ts`.

## Consequences

Readers infer the file from the text before a snippet. Revisit if the docs move to tabbed multi-file samples, where titles become the tab labels.

## Alternatives considered

- A title on every fence: shell commands and partial snippets would get invented names that point at no file.
