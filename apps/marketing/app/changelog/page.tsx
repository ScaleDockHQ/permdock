import { Badge } from '@/components/reui/badge';
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from '@/components/reui/timeline';
import { loadChangelogs } from '@/lib/changelogs';

export const metadata = {
  title: 'Changelog',
  description: 'Releases from permdock, @permdock/cli and @permdock/testing.',
};

export default function ChangelogPage() {
  const releases = loadChangelogs();
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16 md:px-8">
      <div className="mb-10 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Changelog</h1>
        <p className="text-muted-foreground text-base leading-7">
          Built at compile time from packages/permdock, packages/cli and
          packages/testing CHANGELOG.md files.
        </p>
      </div>
      {releases.length === 0 ? (
        <p className="text-muted-foreground text-sm leading-6">
          No releases yet. The first release is 0.1.0.
        </p>
      ) : null}
      <Timeline defaultValue={1} className="w-full">
        {releases.map((release, index) => (
          <TimelineItem
            key={`${release.packageName}-${release.version}-${release.kind}-${String(index)}`}
            step={index + 1}
            className="group-data-[orientation=vertical]/timeline:not-last:pb-8 sm:group-data-[orientation=vertical]/timeline:ms-32"
          >
            <TimelineHeader>
              <TimelineSeparator />
              <TimelineDate className="sm:group-data-[orientation=vertical]/timeline:absolute sm:group-data-[orientation=vertical]/timeline:-left-32 sm:group-data-[orientation=vertical]/timeline:w-24 sm:group-data-[orientation=vertical]/timeline:text-right">
                {release.packageName}
              </TimelineDate>
              <TimelineTitle>
                {release.version} · {release.kind}
              </TimelineTitle>
              <TimelineIndicator />
            </TimelineHeader>
            <TimelineContent className="space-y-2.5">
              <ul className="list-disc space-y-1 pl-4 text-sm leading-6">
                {release.changes.map((change) => (
                  <li key={change.text}>
                    {change.hash ? (
                      <span className="text-muted-foreground font-mono text-xs">
                        {change.hash}:{' '}
                      </span>
                    ) : null}
                    {change.text}
                  </li>
                ))}
              </ul>
              <Badge variant="outline">{release.kind} Changes</Badge>
            </TimelineContent>
          </TimelineItem>
        ))}
      </Timeline>
    </div>
  );
}
