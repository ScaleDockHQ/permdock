import type { ChangelogRelease } from "@/lib/changelog";

import { SiteLink } from "@/components/site/site-link";
import { Badge } from "@permdock/ui/reui/badge";
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from "@permdock/ui/reui/timeline";

import { Section } from "./section";

function InlineCode({ text }: { text: string }) {
  return text.split("`").map((part, index) =>
    index % 2 === 1 ? (
      // oxlint-disable-next-line react/no-array-index-key -- segments of one fixed string
      <code key={index} className="font-mono text-xs text-foreground">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

export function RecentShips({
  releases,
}: {
  releases: readonly ChangelogRelease[];
}) {
  return (
    <Section
      id="ships"
      eyebrow="Recent ships"
      title={`What landed in ${releases[0]?.version ?? "permdock"}`}
      description="Parsed from the package changelogs. The full log is in the docs."
    >
      <Timeline defaultValue={1} className="w-full">
        {releases.map((release, index) => (
          <TimelineItem
            key={`${release.packageName}-${release.version}-${release.kind}`}
            step={index + 1}
            className="group-data-[orientation=vertical]/timeline:not-last:pb-8 sm:group-data-[orientation=vertical]/timeline:ms-32"
          >
            <TimelineHeader>
              <TimelineSeparator />
              <TimelineDate className="sm:group-data-[orientation=vertical]/timeline:absolute sm:group-data-[orientation=vertical]/timeline:-left-32 sm:group-data-[orientation=vertical]/timeline:w-20 sm:group-data-[orientation=vertical]/timeline:text-right">
                {release.packageName}
              </TimelineDate>
              <TimelineTitle>
                {release.version} {release.kind}
              </TimelineTitle>
              <TimelineIndicator />
            </TimelineHeader>
            <TimelineContent className="flex flex-col gap-2.5">
              <ul className="flex list-disc flex-col gap-1 pl-4 text-sm leading-6 text-muted-foreground">
                {release.changes.slice(0, 4).map((change) => (
                  <li key={change.text}>
                    <span className="line-clamp-2">
                      <InlineCode text={change.text} />
                    </span>
                  </li>
                ))}
              </ul>
              <Badge variant="outline">{release.kind}</Badge>
            </TimelineContent>
          </TimelineItem>
        ))}
      </Timeline>
      <p className="mt-6 text-sm">
        <SiteLink
          href="/docs/changelog"
          className="text-primary underline-offset-4 hover:underline"
        >
          Full changelog
        </SiteLink>
      </p>
    </Section>
  );
}
