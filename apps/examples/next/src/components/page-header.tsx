import type { ReactNode } from "react";

export function PageHeader(props: {
  readonly title: string;
  readonly description: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex flex-col gap-1">
        <h1
          data-testid="page-title"
          className="text-2xl font-semibold tracking-tight"
        >
          {props.title}
        </h1>
        <p className="text-muted-foreground text-sm text-pretty">
          {props.description}
        </p>
      </div>
      {props.action}
    </div>
  );
}
