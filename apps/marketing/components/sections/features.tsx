import type { ReactNode } from "react";

import {
  BotIcon,
  BracesIcon,
  DatabaseIcon,
  LayoutTemplateIcon,
  ShieldCheckIcon,
  SplitIcon,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@permdock/ui/components/card";
import { Badge } from "@permdock/ui/reui/badge";
import { IconTile } from "@permdock/ui/reui/icon-tile";

import { Section } from "./section";

type Feature = {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  /** Categorical identity per card, each with its dark pair. */
  readonly tone: string;
  readonly span: string;
  readonly illustration: ReactNode;
};

function Mini({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/60 p-3 font-mono text-xs text-muted-foreground">
      {children}
    </div>
  );
}

const outcomes = [
  { label: "granted", variant: "success-light" },
  { label: "approval-required", variant: "warning-light" },
  { label: "denied", variant: "destructive-light" },
] as const;

const toolCalls = [
  { tool: "search_docs", outcome: outcomes[0] },
  { tool: "refund_invoice", outcome: outcomes[1] },
  { tool: "delete_org", outcome: outcomes[2] },
] as const;

const features: readonly Feature[] = [
  {
    title: "Typed references",
    description:
      "Permissions are objects your editor completes. A renamed action fails the build instead of a request.",
    icon: <BracesIcon aria-hidden="true" />,
    tone: "text-blue-600 dark:text-blue-400",
    span: "md:col-span-4",
    illustration: (
      <Mini>
        <span>
          permdock.can(permissions.post.
          <span className="text-foreground">update</span>, post)
        </span>
        <div className="flex flex-wrap gap-1.5">
          {["read", "update", "delete", "publish"].map((action) => (
            <span
              key={action}
              className={
                action === "update"
                  ? "rounded-sm bg-info/10 px-1.5 py-0.5 text-info-foreground dark:bg-info/15 dark:text-info"
                  : "rounded-sm bg-background px-1.5 py-0.5"
              }
            >
              {action}
            </span>
          ))}
        </div>
      </Mini>
    ),
  },
  {
    title: "Three outcomes",
    description:
      "decide() returns granted, denied or approval-required. There is no fourth.",
    icon: <SplitIcon aria-hidden="true" />,
    tone: "text-emerald-600 dark:text-emerald-400",
    span: "md:col-span-2",
    illustration: (
      <div className="flex flex-wrap gap-2">
        {outcomes.map((outcome) => (
          <Badge key={outcome.label} variant={outcome.variant}>
            {outcome.label}
          </Badge>
        ))}
      </div>
    ),
  },
  {
    title: "Conditions compile to SQL",
    description:
      "One portable where runs in memory and compiles to Drizzle, Prisma, Kysely and Postgres RLS.",
    icon: <DatabaseIcon aria-hidden="true" />,
    tone: "text-violet-600 dark:text-violet-400",
    span: "md:col-span-2",
    illustration: (
      <Mini>
        <span>{"{ authorId: { eq: subject.id } }"}</span>
        <span className="text-foreground">where author_id = $1</span>
      </Mini>
    ),
  },
  {
    title: "Agent tools behind the same policy",
    description:
      "MCP, the AI SDK, the Claude Agent SDK and OpenAI Agents call decide() before a tool runs. An agent never approves its own call.",
    icon: <BotIcon aria-hidden="true" />,
    tone: "text-amber-600 dark:text-amber-400",
    span: "md:col-span-4",
    illustration: (
      <ul className="flex flex-col gap-2">
        {toolCalls.map((call) => (
          <li
            key={call.tool}
            className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2"
          >
            <span className="font-mono text-xs text-foreground">
              {call.tool}
            </span>
            <Badge variant={call.outcome.variant}>{call.outcome.label}</Badge>
          </li>
        ))}
      </ul>
    ),
  },
  {
    title: "UI that matches the server",
    description:
      "The client reads a snapshot of the same decisions, so a hidden button and a refused request never disagree.",
    icon: <LayoutTemplateIcon aria-hidden="true" />,
    tone: "text-sky-600 dark:text-sky-400",
    span: "md:col-span-3",
    illustration: (
      <Mini>
        <span>usePermission(permissions.post.update, post)</span>
        <span className="text-foreground">
          {"{ allowed: false, decision: { outcome: 'denied' } }"}
        </span>
      </Mini>
    ),
  },
  {
    title: "Fail-closed",
    description:
      "An unknown subject, an invalid body or a condition that throws is denied. can() never throws.",
    icon: <ShieldCheckIcon aria-hidden="true" />,
    tone: "text-rose-600 dark:text-rose-400",
    span: "md:col-span-3",
    illustration: (
      <Mini>
        {["unknown subject", "invalid body", "condition threw"].map((cause) => (
          <span key={cause} className="flex items-center justify-between">
            {cause}
            <span className="text-foreground">denied</span>
          </span>
        ))}
      </Mini>
    ),
  },
];

export function Features() {
  return (
    <Section
      id="features"
      eyebrow="Why PermDock"
      title="Authorisation as typed code, checked everywhere it runs"
      description="One policy object drives the UI, the HTTP layer, the database and the agent tools."
    >
      <div className="grid gap-4 md:grid-cols-6">
        {features.map((feature) => (
          <Card key={feature.title} className={feature.span}>
            <CardHeader className="gap-3">
              <IconTile variant="soft" className={feature.tone}>
                {feature.icon}
              </IconTile>
              <div className="flex flex-col gap-0.5">
                <CardTitle>
                  <h3>{feature.title}</h3>
                </CardTitle>
                <CardDescription>{feature.description}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="mt-auto">
              {feature.illustration}
            </CardContent>
          </Card>
        ))}
      </div>
    </Section>
  );
}
