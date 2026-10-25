---
"permdock": patch
---

The better-supabase adapter page shows a calendar or feed URL on a share link with no expiry: `subjectFromShareLink` resolves the link on every poll, so revoking it empties the feed on the next request.
