'use client';

import { useState } from 'react';

import {
  DEMO_ACTIONS,
  DEMO_ROLES,
  demoDecide,
  type DemoAction,
  type DemoDecisionView,
  type DemoRole,
} from '@/lib/devtools-demo';

const SELECT_CLASS = 'rounded-md border border-border bg-background px-3 py-2';

function isDemoRole(value: string): value is DemoRole {
  return DEMO_ROLES.some((role) => role === value);
}

function isDemoAction(value: string): value is DemoAction {
  return DEMO_ACTIONS.some((action) => action === value);
}

function RoleSelect({
  value,
  onChange,
}: {
  value: DemoRole;
  onChange: (role: DemoRole) => void;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      Role
      <select
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (isDemoRole(next)) {
            onChange(next);
          }
        }}
      >
        {DEMO_ROLES.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActionSelect({
  value,
  onChange,
}: {
  value: DemoAction;
  onChange: (action: DemoAction) => void;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      Permission
      <select
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (isDemoAction(next)) {
            onChange(next);
          }
        }}
      >
        {DEMO_ACTIONS.map((name) => (
          <option key={name} value={name}>
            post.{name}
          </option>
        ))}
      </select>
    </label>
  );
}

function DecisionView({ view }: { view: DemoDecisionView }) {
  return (
    <dl className="grid gap-3 rounded-lg border border-border p-4 text-sm">
      <div>
        <dt className="text-muted-foreground">Permission</dt>
        <dd className="font-mono">{view.permission}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Outcome</dt>
        <dd className="font-mono">{view.outcome}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">describe()</dt>
        <dd>
          {view.description.title}. {view.description.detail}
        </dd>
      </div>
    </dl>
  );
}

export function DevtoolsPanel() {
  const [roleName, setRoleName] = useState<DemoRole>('member');
  const [action, setAction] = useState<DemoAction>('delete');
  const view = demoDecide(roleName, action);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <RoleSelect value={roleName} onChange={setRoleName} />
        <ActionSelect value={action} onChange={setAction} />
      </div>
      <DecisionView view={view} />
    </div>
  );
}
