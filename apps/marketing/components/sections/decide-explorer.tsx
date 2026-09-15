'use client';

import { useMemo, useState } from 'react';

import { Badge } from '@/components/reui/badge';
import { Frame, FramePanel } from '@/components/reui/frame';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  DEMO_ACTIONS,
  DEMO_ROLES,
  demoDecide,
  type DemoAction,
  type DemoRole,
} from '@/lib/demo-policy';

import { Section } from './section';

function isDemoRole(value: string): value is DemoRole {
  return (DEMO_ROLES as readonly string[]).includes(value);
}

function isDemoAction(value: string): value is DemoAction {
  return (DEMO_ACTIONS as readonly string[]).includes(value);
}

export function DecideExplorer() {
  const [role, setRole] = useState<DemoRole>('member');
  const [action, setAction] = useState<DemoAction>('publish');
  const view = useMemo(() => demoDecide(role, action), [role, action]);

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
                if (typeof next === 'string' && isDemoRole(next)) {
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
                if (typeof next === 'string' && isDemoAction(next)) {
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
                view.outcome === 'granted'
                  ? 'success-light'
                  : view.outcome === 'approval-required'
                    ? 'warning-light'
                    : 'destructive-light'
              }
            >
              {view.outcome}
            </Badge>
            <p className="font-medium">{view.description.title}</p>
            <p className="text-muted-foreground text-sm leading-6">
              {view.description.detail}
            </p>
          </div>
        </FramePanel>
      </Frame>
    </Section>
  );
}
