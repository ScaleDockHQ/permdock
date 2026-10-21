"use client";

import type { IntegrationKind, Preset, PresetInput } from "permdock/preset";
import type { ReactNode } from "react";

import { CircleAlertIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import {
  ARCHETYPES,
  AUTH,
  BACKENDS,
  FEATURES,
  FRAMEWORKS,
  INTEGRATIONS,
  PRESET_DEFAULTS,
  SERVICES,
  decodePreset,
  generatePreset,
  presetMatrix,
  resolvePreset,
} from "permdock/preset";
import { useEffect, useState } from "react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@permdock/ui/components/alert";
import { Button } from "@permdock/ui/components/button";
import { Separator } from "@permdock/ui/components/separator";
import { Skeleton } from "@permdock/ui/components/skeleton";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@permdock/ui/reui/frame";

import { CheckboxCards, RadioCards } from "./choice-cards";
import { InstallPanel, OutputTabs, PreviewSkeleton } from "./preview";

const START: PresetInput = { archetype: PRESET_DEFAULTS.archetype };

const AGENT_RUNTIMES = INTEGRATIONS.filter((item) => item.kind === "agent");
const UI_RECIPES = INTEGRATIONS.filter((item) => item.kind === "ui");

function Step({
  step,
  title,
  description,
  children,
}: {
  readonly step: number;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <Frame>
      <FrameHeader className="flex-row items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground tabular-nums"
        >
          {step}
        </span>
        <div className="flex flex-col gap-0.5">
          <FrameTitle>
            <h2>{title}</h2>
          </FrameTitle>
          <FrameDescription>{description}</FrameDescription>
        </div>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-5">{children}</FramePanel>
    </Frame>
  );
}

function SubGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{label}</h3>
      {children}
    </div>
  );
}

export function CreateBuilder() {
  const search = useSearchParams();
  const code = search.get("preset");
  const [invalid, setInvalid] = useState(
    () => code !== null && decodePreset(code) === undefined,
  );
  const [input, setInput] = useState<PresetInput>(() =>
    code === null ? START : (decodePreset(code) ?? START),
  );
  const preset: Preset = resolvePreset(input);
  const generated = generatePreset(preset);
  const matrix = presetMatrix(preset);
  const locked = resolvePreset({
    archetype: preset.archetype,
    integrations: preset.integrations,
  }).features;

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("preset", generated.code);
    window.history.replaceState(null, "", url);
  }, [generated.code]);

  const set = (patch: Partial<PresetInput>) => {
    setInput({ ...preset, ...patch });
  };
  const ofKind = (kind: IntegrationKind) =>
    preset.integrations.filter(
      (id) => INTEGRATIONS.find((item) => item.id === id)?.kind === kind,
    );
  const setKind = (kind: IntegrationKind, ids: readonly string[]) => {
    set({
      integrations: INTEGRATIONS.filter((item) =>
        item.kind === kind
          ? ids.includes(item.id)
          : preset.integrations.includes(item.id),
      ).map((item) => item.id),
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {invalid ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>That preset link is not valid</AlertTitle>
          <AlertDescription>
            The builder opened with the default preset instead.
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setInput(START);
                setInvalid(false);
              }}
            >
              Reset
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Step
            step={1}
            title="Archetype"
            description="The kind of app sets the resources, roles and defaults."
          >
            <RadioCards
              name="archetype"
              label="Archetype"
              choices={ARCHETYPES}
              value={preset.archetype}
              onChange={(archetype) =>
                setInput({ ...preset, archetype, features: [] })
              }
            />
          </Step>

          <Step
            step={2}
            title="Features"
            description="Required features follow from the archetype and agent runtimes."
          >
            <CheckboxCards
              name="feature"
              label="Features"
              choices={FEATURES}
              value={preset.features}
              locked={locked}
              onChange={(features) => set({ features })}
            />
          </Step>

          <Step
            step={3}
            title="Stack"
            description="Where requests arrive, who signs users in and where data lives."
          >
            <SubGroup label="Framework">
              <RadioCards
                name="framework"
                label="Framework"
                choices={FRAMEWORKS}
                value={preset.framework}
                onChange={(framework) => set({ framework })}
              />
            </SubGroup>
            <Separator />
            <SubGroup label="Auth">
              <RadioCards
                name="auth"
                label="Auth"
                choices={AUTH}
                value={preset.auth}
                onChange={(auth) => set({ auth })}
              />
            </SubGroup>
            <Separator />
            <SubGroup label="Backend">
              <RadioCards
                name="backend"
                label="Backend"
                choices={BACKENDS}
                value={preset.backend}
                onChange={(backend) => set({ backend })}
              />
            </SubGroup>
          </Step>

          <Step
            step={4}
            title="Integrations"
            description="Gate agent tools and get UI recipes built on useGate."
          >
            <SubGroup label="Agent runtimes">
              <CheckboxCards
                name="integration"
                label="Agent runtimes"
                choices={AGENT_RUNTIMES}
                value={ofKind("agent")}
                onChange={(ids) => setKind("agent", ids)}
              />
            </SubGroup>
            <Separator />
            <SubGroup label="UI recipes">
              <CheckboxCards
                name="integration"
                label="UI recipes"
                choices={UI_RECIPES}
                value={ofKind("ui")}
                onChange={(ids) => setKind("ui", ids)}
              />
            </SubGroup>
          </Step>

          <Step
            step={5}
            title="PermDock Cloud"
            description="Optional. Each service sits behind a PermDock interface and is never on the decision path; without it the app uses the in-process default."
          >
            <CheckboxCards
              name="service"
              label="PermDock Cloud"
              choices={SERVICES}
              value={preset.services}
              onChange={(services) => set({ services })}
            />
          </Step>
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <InstallPanel generated={generated} />
          <OutputTabs
            generated={generated}
            matrix={matrix}
            onPickUi={() => setKind("ui", ["shadcn"])}
          />
        </div>
      </div>
    </div>
  );
}

export function CreateBuilderSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
    >
      <div className="flex flex-col gap-6">
        <Skeleton className="h-[28rem] w-full" />
        <Skeleton className="h-[36rem] w-full" />
      </div>
      <PreviewSkeleton />
    </div>
  );
}
