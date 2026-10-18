import type { ReactNode } from "react";

import {
  BotIcon,
  Building2Icon,
  BriefcaseIcon,
  ClipboardCheckIcon,
  CloudIcon,
  CodeIcon,
  CreditCardIcon,
  DatabaseIcon,
  GaugeIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  MemoryStickIcon,
  ScrollTextIcon,
  ServerIcon,
  StoreIcon,
  UserCheckIcon,
  UserCogIcon,
  UsersIcon,
} from "lucide-react";

import { AdapterLogo } from "@/components/sections/adapter-logos";

/** A logo for a third-party choice, an icon for PermDock's own. */
const media: Readonly<Record<string, ReactNode>> = {
  b2b: <Building2Icon aria-hidden="true" />,
  agent: <BotIcon aria-hidden="true" />,
  marketplace: <StoreIcon aria-hidden="true" />,
  api: <ServerIcon aria-hidden="true" />,
  internal: <BriefcaseIcon aria-hidden="true" />,
  consumer: <UsersIcon aria-hidden="true" />,
  tenancy: <Building2Icon aria-hidden="true" />,
  "custom-roles": <UserCogIcon aria-hidden="true" />,
  approvals: <ClipboardCheckIcon aria-hidden="true" />,
  agents: <BotIcon aria-hidden="true" />,
  audit: <ScrollTextIcon aria-hidden="true" />,
  limits: <GaugeIcon aria-hidden="true" />,
  plans: <CreditCardIcon aria-hidden="true" />,
  ownership: <UserCheckIcon aria-hidden="true" />,
  "api-keys": <KeyRoundIcon aria-hidden="true" />,
  rls: <DatabaseIcon aria-hidden="true" />,
  custom: <KeyRoundIcon aria-hidden="true" />,
  supabase: <AdapterLogo name="Supabase" />,
  "better-auth": <AdapterLogo name="Better Auth" />,
  clerk: <AdapterLogo name="Clerk" />,
  jwt: <AdapterLogo name="JWT" />,
  memory: <MemoryStickIcon aria-hidden="true" />,
  drizzle: <AdapterLogo name="Drizzle" />,
  prisma: <AdapterLogo name="Prisma" />,
  next: <AdapterLogo name="Next.js" />,
  hono: <AdapterLogo name="Hono" />,
  express: <AdapterLogo name="Express" />,
  none: <CodeIcon aria-hidden="true" />,
  "ai-sdk": <AdapterLogo name="AI SDK" />,
  mcp: <AdapterLogo name="MCP" />,
  shadcn: <LayoutTemplateIcon aria-hidden="true" />,
  "react-native": <AdapterLogo name="React Native" />,
};

export function choiceMedia(id: string): ReactNode {
  return media[id] ?? <CloudIcon aria-hidden="true" />;
}
