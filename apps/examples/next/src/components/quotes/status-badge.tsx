import { Badge } from "@/components/ui/badge.tsx";

import type { Quote } from "../../permissions.ts";

export function StatusBadge(props: {
  readonly status: Quote["status"];
  readonly testId?: string;
}) {
  switch (props.status) {
    case "draft":
      return (
        <Badge variant="outline" data-testid={props.testId}>
          draft
        </Badge>
      );
    case "sent":
      return (
        <Badge
          className="bg-warning/15 text-warning-foreground"
          data-testid={props.testId}
        >
          sent
        </Badge>
      );
    case "approved":
      return (
        <Badge
          className="bg-success/15 text-success-foreground"
          data-testid={props.testId}
        >
          approved
        </Badge>
      );
    default: {
      const exhaustive: never = props.status;
      return exhaustive;
    }
  }
}
