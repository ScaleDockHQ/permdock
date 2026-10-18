"use client";

import type {
  GeneratedPreset,
  MatrixAccess,
  PresetMatrix,
} from "permdock/preset";

import {
  ArrowUpRightIcon,
  CheckIcon,
  FileCodeIcon,
  LayoutTemplateIcon,
  LinkIcon,
  ShieldOffIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DocsHref } from "@/lib/site";

import { InstallCopy } from "@/components/sections/install-copy";
import { SiteLink } from "@/components/site/site-link";
import { Button } from "@permdock/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@permdock/ui/components/empty";
import { Skeleton } from "@permdock/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@permdock/ui/components/table";
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
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@permdock/ui/reui/code-block/code-block";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@permdock/ui/reui/frame";

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "ts",
  tsx: "tsx",
  sql: "sql",
  json: "json",
  md: "md",
  toml: "toml",
};

function languageOf(path: string): string {
  return LANGUAGES[path.split(".").pop() ?? ""] ?? "text";
}

const ACCESS = {
  allow: { label: "yes", variant: "success-light" },
  own: { label: "own rows", variant: "info-light" },
  pro: { label: "pro plan", variant: "primary-light" },
  none: { label: "no", variant: "outline" },
} as const;

function AccessCell({ cell }: { cell: MatrixAccess | undefined }) {
  const access = ACCESS[cell?.access ?? "none"];
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant={access.variant}>{access.label}</Badge>
      {cell?.approval ? <Badge variant="warning-light">approval</Badge> : null}
      {cell?.limit ? <Badge variant="outline">limit</Badge> : null}
    </div>
  );
}

function docTitle(path: string): string {
  const slug = path.split("/").pop() ?? path;
  const words = slug.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isDocsHref(path: string): path is DocsHref {
  return path.startsWith("/docs");
}

function CopyLink() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          setCopied(true);
          if (timer.current) {
            clearTimeout(timer.current);
          }
          timer.current = setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard is unavailable outside a secure context.
        }
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden="true" />
      ) : (
        <LinkIcon aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}

export function InstallPanel({ generated }: { generated: GeneratedPreset }) {
  return (
    <Frame>
      <FrameHeader className="flex-row items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <FrameTitle>Install</FrameTitle>
          <FrameDescription>
            Preset <span className="font-mono">{generated.code}</span>
          </FrameDescription>
        </div>
        <CopyLink />
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <Tabs defaultValue="cli" className="gap-3">
          <TabsList>
            <TabsTrigger value="cli">permdock CLI</TabsTrigger>
            <TabsTrigger value="shadcn">shadcn</TabsTrigger>
          </TabsList>
          <TabsContent value="cli">
            <InstallCopy
              command={`npx permdock init --preset ${generated.code}`}
            />
          </TabsContent>
          <TabsContent value="shadcn">
            <InstallCopy
              command={`npx shadcn@latest add https://permdock.com/r/preset-${generated.code}.json`}
            />
          </TabsContent>
        </Tabs>
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Both write the same files. Then add the dependencies:
          </p>
          {generated.dependencies.length > 0 ? (
            <InstallCopy
              command={`npm install ${generated.dependencies.join(" ")}`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              None beyond permdock.
            </p>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
}

export function OutputTabs({
  generated,
  matrix,
  onPickUi,
}: {
  generated: GeneratedPreset;
  matrix: PresetMatrix;
  onPickUi: () => void;
}) {
  const [file, setFile] = useState(0);
  const shown = generated.files[Math.min(file, generated.files.length - 1)];

  return (
    <Tabs defaultValue="files" className="gap-3">
      <TabsList>
        <TabsTrigger value="files">
          Files <Badge variant="secondary">{generated.files.length}</Badge>
        </TabsTrigger>
        <TabsTrigger value="access">Who may do what</TabsTrigger>
        <TabsTrigger value="ui">UI</TabsTrigger>
        <TabsTrigger value="next">Next steps</TabsTrigger>
      </TabsList>

      <TabsContent value="files">
        <Frame>
          <FramePanel className="flex flex-col gap-3">
            <ToggleGroup
              value={[String(file)]}
              multiple={false}
              variant="outline"
              size="sm"
              className="flex-wrap"
              aria-label="Generated files"
              onValueChange={(values) => {
                const next = Number(values[0]);
                if (Number.isInteger(next)) {
                  setFile(next);
                }
              }}
            >
              {generated.files.map((item, index) => (
                <ToggleGroupItem
                  key={item.path}
                  value={String(index)}
                  className="font-mono"
                >
                  <FileCodeIcon aria-hidden="true" />
                  {item.path}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {shown === undefined ? null : (
              <CodeBlock
                key={shown.path}
                code={shown.contents}
                language={languageOf(shown.path)}
                label={shown.path}
                showLineNumbers
                maxLines={28}
              >
                <CodeBlockCopyButton />
              </CodeBlock>
            )}
            <p className="text-xs leading-5 text-muted-foreground">
              Every file is your own code: declarations and wiring. The rules
              they call stay in the permdock package, so an update reaches them.
            </p>
          </FramePanel>
        </Frame>
      </TabsContent>

      <TabsContent value="access">
        <Frame>
          <FramePanel className="p-0">
            {matrix.rows.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <ShieldOffIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No permissions yet</EmptyTitle>
                  <EmptyDescription>
                    Pick an archetype to generate its resources and roles.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Permission</TableHead>
                    {matrix.roles.map((role) => (
                      <TableHead key={role}>{role}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matrix.rows.map((row) => (
                    <TableRow key={`${row.resource}.${row.action}`}>
                      <TableCell className="font-mono text-xs">
                        {row.resource}.{row.action}
                      </TableCell>
                      {matrix.roles.map((role) => (
                        <TableCell key={role}>
                          <AccessCell cell={row.cells[role]} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </FramePanel>
        </Frame>
      </TabsContent>

      <TabsContent value="ui">
        <Frame>
          <FramePanel className="flex flex-col gap-3">
            {generated.recipes.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <LayoutTemplateIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No UI recipes</EmptyTitle>
                  <EmptyDescription>
                    Add shadcn/ui or React Native Reusables to get gated
                    components.
                  </EmptyDescription>
                </EmptyHeader>
                <Button type="button" variant="outline" onClick={onPickUi}>
                  Add shadcn/ui recipes
                </Button>
              </Empty>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {generated.recipes.map((recipe) => (
                    <Badge key={recipe} variant="outline" className="font-mono">
                      {recipe}
                    </Badge>
                  ))}
                </div>
                <p className="text-sm text-muted-foreground">
                  Markup over useGate, built from your own components. The
                  preset command installs them; each also installs on its own
                  from{" "}
                  <code className="font-mono text-xs">
                    https://permdock.com/r/&lt;name&gt;.json
                  </code>
                  .
                </p>
              </>
            )}
          </FramePanel>
        </Frame>
      </TabsContent>

      <TabsContent value="next">
        <Frame>
          <FramePanel>
            <ul className="flex flex-col gap-1">
              {generated.docs.filter(isDocsHref).map((path) => (
                <li key={path}>
                  <SiteLink
                    href={path}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                  >
                    {docTitle(path)}
                    <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                      {path}
                      <ArrowUpRightIcon
                        aria-hidden="true"
                        className="size-3.5"
                      />
                    </span>
                  </SiteLink>
                </li>
              ))}
            </ul>
          </FramePanel>
        </Frame>
      </TabsContent>
    </Tabs>
  );
}

export function PreviewSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-52 w-full" />
      <Skeleton className="h-9 w-80" />
      <Skeleton className="h-[34rem] w-full" />
    </div>
  );
}
