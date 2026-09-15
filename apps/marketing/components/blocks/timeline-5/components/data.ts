export type ChangelogItem = {
  id: number
  date: string
  dateTime: string
  title: string
  type: "New" | "Improved" | "Fixed" | "Security"
  impact: string
  description: string
  changes: string[]
}

export const changelogItems: ChangelogItem[] = [
  {
    id: 1,
    date: "May 2025",
    dateTime: "2025-05",
    title: "v2.5 Release Channels",
    type: "New",
    impact: "Team Rollout",
    description:
      "Create staged release channels for beta teams, enterprise accounts, and internal QA cohorts.",
    changes: ["Channel Permissions", "Scheduled Publishing"],
  },
  {
    id: 2,
    date: "Apr 2025",
    dateTime: "2025-04",
    title: "v2.4 AI Assist",
    type: "New",
    impact: "Faster Reviews",
    description:
      "Added workspace summaries, prompt presets, and faster review suggestions.",
    changes: ["Prompt Library", "Review Summaries"],
  },
  {
    id: 3,
    date: "Mar 2025",
    dateTime: "2025-03",
    title: "v2.3 Theme Studio",
    type: "Improved",
    impact: "Design Systems",
    description:
      "Introduced token previews, component states, and one-click CSS exports.",
    changes: ["Token Previews", "CSS Export"],
  },
  {
    id: 4,
    date: "Feb 2025",
    dateTime: "2025-02",
    title: "v2.2 Live Editing",
    type: "Improved",
    impact: "Collaboration",
    description:
      "Improved shared cursors, presence labels, and conflict-safe draft recovery.",
    changes: ["Presence Labels", "Draft Recovery"],
  },
]