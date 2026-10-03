# 0022. Unbuilt features carry a `Status:` line

- Status: accepted
- Date: 2026-10-03

## Context

The standard marks an unbuilt feature with a "Coming soon" callout. Agents read these docs as Markdown (`/docs.md`, `llms-full.txt`, the docs MCP server), where a callout component becomes JSX or disappears, and an agent that misses it writes an import path that does not exist.

## Decision

A page for something not built yet has a plain `Status: planned` (an adapter or feature) or `Status: tracking` (a standard PermDock follows without an adapter) line directly under the frontmatter. The line is removed in the pull request that ships the code. `.agents/rules/docs.mdc` owns the rule.

## Consequences

The status is the same text in HTML and in every Markdown output. It is not styled as a callout on the site.

## Alternatives considered

- A "Coming soon" callout: invisible or noisy in the Markdown outputs agents read.
- A frontmatter field rendered as a badge: the Markdown outputs drop frontmatter, so agents would lose the status.
