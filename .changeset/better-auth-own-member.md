---
'permdock': patch
---

`subjectFromBetterAuth` now reads only the session user's own `member` rows. Before, the `listMembers` fallback returned every member of the organization and merged all their roles into the subject. It lists organization ids with `listOrganizations`, then calls `getActiveMember` for the active organization and `listMembers` filtered by `userId` elsewhere. It drops any row whose `userId` is another user's and reads teams from `listUserTeams` instead of the organization-wide `listTeams`. A failed lookup drops only that organization.
