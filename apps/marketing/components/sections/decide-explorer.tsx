"use client";

import { useState } from "react";

import {
  DEMO_ACTIONS,
  DEMO_ROLES,
  demoDecide,
  type DemoAction,
  type DemoRole,
} from "@/lib/demo-policy";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@permdock/ui/components/toggle-group";
import { Badge } from "@permdock/ui/reui/badge";
import { Frame, FramePanel } from "@permdock/ui/reui/frame";

import { Section } from "./section";

function isDemoRole(value: string): value is DemoRole {
  // SAFETY: widens the literal tuple so includes() accepts any string
  return (DEMO_ROLES as readonly string[]).includes(value);
}

function isDemoAction(value: string): value is DemoAction {
  // SAFETY: widens the literal tuple so includes() accepts any string
  return (DEMO_ACTIONS as readonly string[]).includes(value);
}

export function DecideExplorer() {
  const [role, setRole] = useState<DemoRole>("member");
  const [action, setAction] = useState<DemoAction>("publish");
  const view = demoDecide(role, action);

  return (
    <Section
      id="decide"
      eyebrow="Interactive"
      title="decide() in the browser"
      description="A real PermDock policy. Switch role and action to see granted, denied and approval-required."
    >
      <Frame data-testid="decide-explorer">
        <FramePanel className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">Role</p>
            <ToggleGroup
              value={[role]}
              multiple={false}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next === "string" && isDemoRole(next)) {
                  setRole(next);
                }
              }}
              variant="outline"
            >
              {DEMO_ROLES.map((name) => (
                <ToggleGroupItem key={name} value={name}>
                  {name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">Action</p>
            <ToggleGroup
              value={[action]}
              multiple={false}
              onValueChange={(values) => {
                const next = values[0];
                if (typeof next === "string" && isDemoAction(next)) {
                  setAction(next);
                }
              }}
              variant="outline"
              className="flex-wrap"
            >
              {DEMO_ACTIONS.map((name) => (
                <ToggleGroupItem key={name} value={name}>
                  {name}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-2">
            <Badge
              variant={
                view.outcome === "granted"
                  ? "success-light"
                  : view.outcome === "approval-required"
                    ? "warning-light"
                    : "destructive-light"
              }
            >
              {view.outcome}
            </Badge>
            <p className="font-medium">{view.description.title}</p>
            <p className="text-sm leading-6 text-muted-foreground">
              {view.description.detail}
            </p>
          </div>
        </FramePanel>
      </Frame>
    </Section>
  );
}
