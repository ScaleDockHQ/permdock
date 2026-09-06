# Security policy

## Reporting a vulnerability

Report vulnerabilities privately. Do not open a public GitHub issue, discussion, or pull request.

Use GitHub private vulnerability reporting:

https://github.com/ScaleDockHQ/PermDock/security/advisories/new

We acknowledge security reports within 48 hours.

## Supported versions

PermDock is not published on npm yet (Phase 0). Once `0.x` ships, patch versions on the current minor are supported. There is no long-term support line until 1.0.

| Version               | Supported             |
| --------------------- | --------------------- |
| Unpublished / Phase 0 | Yes (this repository) |
| 0.x (once published)  | Current minor only    |
| 1.x                   | When Phase 4 lands    |

## What to include

- Affected package and version (or commit)
- Reproduction steps
- Impact (auth bypass, grant escalation, fail-open, prototype pollution, and similar)
- Whether the issue is already public
