import { Badge, type BadgeProps } from "@permdock/ui/reui/badge"
import {
  Timeline,
  TimelineContent,
  TimelineDate,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
  TimelineTitle,
} from "@permdock/ui/reui/timeline"

import { changelogItems, type ChangelogItem } from "./data"

const typeVariantMap = {
  New: "primary-light",
  Improved: "info-light",
  Fixed: "success-light",
  Security: "warning-light",
} satisfies Record<ChangelogItem["type"], BadgeProps["variant"]>

const impactVariantMap = {
  New: "focus-light",
  Improved: "primary-light",
  Fixed: "success-light",
  Security: "warning-light",
} satisfies Record<ChangelogItem["type"], BadgeProps["variant"]>

const changeVariants = [
  "info-light",
  "warning-light",
  "success-light",
  "invert-light",
] satisfies BadgeProps["variant"][]

export function ChangelogTimeline() {
  return (
    <section className="w-full max-w-xl" aria-labelledby="changelog-title">
      <div className="mb-6 space-y-1.5 sm:ms-32">
        <h1 id="changelog-title" className="text-xl font-semibold">
          Release Changelog
        </h1>
        <p className="text-muted-foreground text-sm leading-5">
          Recent releases, fixes, and platform updates.
        </p>
      </div>

      <Timeline defaultValue={1} className="w-full">
        {changelogItems.map((item) => (
          <TimelineItem
            key={item.id}
            step={item.id}
            className="group-data-[orientation=vertical]/timeline:not-last:pb-8 sm:group-data-[orientation=vertical]/timeline:ms-32"
          >
            <TimelineHeader>
              <TimelineSeparator className="!bg-primary/10" />
              <TimelineDate
                dateTime={item.dateTime}
                className="sm:group-data-[orientation=vertical]/timeline:absolute sm:group-data-[orientation=vertical]/timeline:-left-32 sm:group-data-[orientation=vertical]/timeline:w-20 sm:group-data-[orientation=vertical]/timeline:text-right"
              >
                {item.date}
              </TimelineDate>
              <TimelineTitle className="sm:-mt-0.5">{item.title}</TimelineTitle>
              <TimelineIndicator />
            </TimelineHeader>
            <TimelineContent className="space-y-2.5">
              <p className="leading-5">{item.description}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant={typeVariantMap[item.type]}>{item.type}</Badge>
                <Badge variant={impactVariantMap[item.type]}>
                  {item.impact}
                </Badge>
                {item.changes.map((change, index) => (
                  <Badge
                    key={change}
                    variant={
                      changeVariants[
                        (index + item.id - 1) % changeVariants.length
                      ]
                    }
                  >
                    {change}
                  </Badge>
                ))}
              </div>
            </TimelineContent>
          </TimelineItem>
        ))}
      </Timeline>
    </section>
  )
}