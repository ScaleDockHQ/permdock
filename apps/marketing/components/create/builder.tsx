"use client";

import { useSearchParams } from "next/navigation";
import {
  AGENTS,
  ARCHETYPES,
  AUTH,
  BACKENDS,
  type Choice,
  FEATURES,
  FRAMEWORKS,
  type Preset,
  type PresetInput,
  SERVICES,
  UI,
  decodePreset,
  generatePreset,
  presetMatrix,
  resolvePreset,
} from "permdock/preset";
import { useEffect, useState } from "react";

import { InstallCopy } from "@/components/sections/install-copy";
import { Skeleton } from "@permdock/ui/components/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@permdock/ui/components/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@permdock/ui/components/toggle-group";
import { Badge } from "@permdock/ui/reui/badge";
import { Frame, FramePanel } from "@permdock/ui/reui/frame";

const START: PresetInput = { archetype: "b2b", ui: ["shadcn"] };
const NONE: readonly never[] = [];

function ids<T extends string>(
  values: readonly unknown[],
  list: readonly Choice<T>[],
): T[] {
  return list.map((choice) => choice.id).filter((id) => values.includes(id));
}

function Group<T extends string>({
  label,
  choices,
  value,
  multiple,
  locked = NONE,
  onChange,
}: {
  readonly label: string;
  readonly choices: readonly Choice<T>[];
  readonly value: readonly T[];
  readonly multiple: boolean;
  readonly locked?: readonly T[];
  readonly onChange: (next: T[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <ToggleGroup
        value={[...value]}
        multiple={multiple}
        variant="outline"
        className="flex-wrap"
        onValueChange={(values) => {
          const next = ids(values, choices);
          if (multiple || next.length > 0) {
            onChange([...new Set([...next, ...locked])]);
          }
        }}
      >
        {choices
          .filter((choice) => choice.retired !== true)
          .map((choice) => (
            <ToggleGroupItem
              key={choice.id}
              value={choice.id}
              title={choice.description}
              disabled={locked.includes(choice.id)}
            >
              {choice.title}
            </ToggleGroupItem>
          ))}
      </ToggleGroup>
    </fieldset>
  );
}

const ACCESS_LABEL = {
  allow: "yes",
  own: "own rows",
  pro: "pro plan",
  none: "no",
} as const;

export function CreateBuilder() {
  const search = useSearchParams();
  const [input, setInput] = useState<PresetInput>(() => {
    const code = search.get("preset");
    return (code === null ? undefined : decodePreset(code)) ?? START;
  });
  const preset: Preset = resolvePreset(input);
  const generated = generatePreset(preset);
  const matrix = presetMatrix(preset);
  const locked = resolvePreset({
    archetype: preset.archetype,
    agents: preset.agents,
  }).features;
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("preset", generated.code);
    window.history.replaceState(null, "", url);
  }, [generated.code]);
  const set = (patch: Partial<PresetInput>) => {
    setInput({ ...preset, ...patch });
  };
  const [file, setFile] = useState(0);
  const shown = generated.files[Math.min(file, generated.files.length - 1)];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <Frame>
        <FramePanel className="flex flex-col gap-5">
          <Group
            label="Archetype"
            choices={ARCHETYPES}
            value={[preset.archetype]}
            multiple={false}
            onChange={(next) => {
              const archetype = next[0];
              if (archetype !== undefined) {
                setInput({ ...preset, archetype, features: [] });
              }
            }}
          />
          <p className="-mt-3 text-sm text-muted-foreground">
            {
              ARCHETYPES.find((item) => item.id === preset.archetype)
                ?.description
            }
          </p>
          <Group
            label="Features"
            choices={FEATURES}
            value={preset.features}
            multiple
            locked={locked}
            onChange={(features) => set({ features })}
          />
          <Group
            label="Framework"
            choices={FRAMEWORKS}
            value={[preset.framework]}
            multiple={false}
            onChange={(next) => set({ framework: next[0] ?? preset.framework })}
          />
          <Group
            label="Auth"
            choices={AUTH}
            value={[preset.auth]}
            multiple={false}
            onChange={(next) => set({ auth: next[0] ?? preset.auth })}
          />
          <Group
            label="Backend"
            choices={BACKENDS}
            value={[preset.backend]}
            multiple={false}
            onChange={(next) => set({ backend: next[0] ?? preset.backend })}
          />
          <Group
            label="Agents"
            choices={AGENTS}
            value={preset.agents}
            multiple
            onChange={(agents) => set({ agents })}
          />
          <Group
            label="UI recipes"
            choices={UI}
            value={preset.ui}
            multiple
            onChange={(ui) => set({ ui })}
          />
          <Group
            label="PermDock Cloud"
            choices={SERVICES}
            value={preset.services}
            multiple
            onChange={(services) => set({ services })}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            Cloud services sit behind PermDock&apos;s own interfaces and are
            never on the decision path. Without them the app uses the in-process
            defaults.
          </p>
        </FramePanel>
      </Frame>

      <div className="flex min-w-0 flex-col gap-4">
        <Frame>
          <FramePanel className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              Preset <Badge variant="secondary">{generated.code}</Badge>
            </p>
            <InstallCopy
              command={`npx permdock init --preset ${generated.code}`}
            />
            <InstallCopy
              command={`npx shadcn@latest add https://permdock.com/r/preset-${generated.code}.json`}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              Both write the same files. Then run{" "}
              {generated.dependencies.length > 0 ? (
                <code>npm install {generated.dependencies.join(" ")}</code>
              ) : null}
              .
            </p>
          </FramePanel>
        </Frame>

        <Tabs defaultValue="files">
          <TabsList>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="access">Who may do what</TabsTrigger>
            <TabsTrigger value="ui">UI</TabsTrigger>
          </TabsList>
          <TabsContent value="files">
            <Frame>
              <FramePanel className="flex flex-col gap-3">
                <ToggleGroup
                  value={[String(file)]}
                  multiple={false}
                  variant="outline"
                  className="flex-wrap"
                  onValueChange={(values) => {
                    const next = Number(values[0]);
                    if (Number.isInteger(next)) {
                      setFile(next);
                    }
                  }}
                >
                  {generated.files.map((item, index) => (
                    <ToggleGroupItem key={item.path} value={String(index)}>
                      {item.path}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted/50 p-4 font-mono text-xs leading-5">
                  <code>{shown?.contents}</code>
                </pre>
                <p className="text-xs leading-5 text-muted-foreground">
                  Every file is your own code: declarations and wiring. The
                  rules they call stay in the permdock package, so an update
                  reaches them.
                </p>
              </FramePanel>
            </Frame>
          </TabsContent>
          <TabsContent value="access">
            <Frame>
              <FramePanel className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left">
                      <th className="py-2 pr-4 font-medium">Permission</th>
                      {matrix.roles.map((role) => (
                        <th key={role} className="py-2 pr-4 font-medium">
                          {role}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((row) => (
                      <tr
                        key={`${row.resource}.${row.action}`}
                        className="border-t"
                      >
                        <td className="py-2 pr-4 font-mono text-xs">
                          {row.resource}.{row.action}
                        </td>
                        {matrix.roles.map((role) => {
                          const cell = row.cells[role];
                          return (
                            <td key={role} className="py-2 pr-4">
                              {cell === undefined
                                ? "no"
                                : ACCESS_LABEL[cell.access]}
                              {cell?.approval ? " · approval" : ""}
                              {cell?.limit ? " · limit" : ""}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </FramePanel>
            </Frame>
          </TabsContent>
          <TabsContent value="ui">
            <Frame>
              <FramePanel className="flex flex-col gap-3">
                {generated.recipes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Pick shadcn/ui or React Native Reusables to add the recipes.
                  </p>
                ) : (
                  <>
                    <ul className="flex flex-col gap-1 font-mono text-sm">
                      {generated.recipes.map((recipe) => (
                        <li key={recipe}>{recipe}</li>
                      ))}
                    </ul>
                    <p className="text-sm text-muted-foreground">
                      Markup over useGate, built from your own components. The
                      preset command installs them; each also installs on its
                      own from{" "}
                      <code>https://permdock.com/r/&lt;name&gt;.json</code>.
                    </p>
                  </>
                )}
              </FramePanel>
            </Frame>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

export function CreateBuilderSkeleton() {
  return (
    <div
      aria-hidden
      className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <Skeleton className="h-[40rem] rounded-xl" />
      <Skeleton className="h-[40rem] rounded-xl" />
    </div>
  );
}
