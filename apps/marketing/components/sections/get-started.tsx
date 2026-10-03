import { getStartedSteps } from "@/lib/site";

import { Section } from "./section";

export function GetStarted() {
  return (
    <Section
      id="get-started"
      eyebrow="Get started"
      title="Install, define, grant, decide"
    >
      <ol className="flex max-w-xl flex-col">
        {getStartedSteps.map((step, index) => (
          <li key={step.title} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground"
              >
                {index + 1}
              </span>
              {index < getStartedSteps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="m-0.5 min-h-8 w-0.5 flex-1 rounded-sm bg-muted"
                />
              ) : null}
            </div>
            <div className="flex flex-col gap-1 pb-6">
              <h3 className="text-sm leading-none font-medium">{step.title}</h3>
              <p className="text-sm text-muted-foreground">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
