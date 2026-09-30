'use client';

import { getStartedSteps } from '@/lib/site';
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from '@permdock/ui/reui/stepper';

import { Section } from './section';

export function GetStarted() {
  return (
    <Section
      id="get-started"
      eyebrow="Get started"
      title="Install, define, grant, decide"
    >
      <Stepper defaultValue={1} orientation="vertical" className="max-w-xl">
        {getStartedSteps.map((step, index) => (
          <StepperItem key={step.title} step={index + 1}>
            <StepperTrigger className="w-full">
              <StepperIndicator />
              <div className="flex flex-col items-start gap-1 text-left">
                <StepperTitle>{step.title}</StepperTitle>
                <StepperDescription>{step.body}</StepperDescription>
              </div>
            </StepperTrigger>
            {index < getStartedSteps.length - 1 ? <StepperSeparator /> : null}
          </StepperItem>
        ))}
      </Stepper>
    </Section>
  );
}
