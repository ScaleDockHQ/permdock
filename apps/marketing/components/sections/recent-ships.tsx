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

export function RecentShips({
  releases,
}: {
  releases: readonly ChangelogRelease[];
}) {
  return (
    <Section
      id="ships"
      eyebrow="Recent ships"
      title="What landed in 0.1.0"
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
            <TimelineContent className="space-y-2.5">
              <ul className="list-disc space-y-1 pl-4 text-sm leading-6 text-muted-foreground">
                {release.changes.slice(0, 4).map((change) => (
                  <li key={change.text}>{change.text}</li>
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
