# Formatting

`pnpm format` runs oxfmt over the whole repository; `pnpm format:check` is the first step of `verify`.

- A formatter reflow after a rename can move the line that an `oxlint-disable-next-line` or `@ts-expect-error` directive must sit above. Put the directive directly above the exact property or expression line it covers, and check it again after `pnpm format`.
- Revert unrelated regenerated output, such as a version header that a generator rewrote, instead of committing it.
