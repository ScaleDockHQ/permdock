"use client";

import { ArrowUpIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@permdock/ui/components/input-group";

const loadChat = () => import("./ask-ai-chat");

function AskAiShell({ onActivate }: { readonly onActivate?: () => void }) {
  return (
    <div
      className="flex h-[70vh] flex-col gap-4"
      onPointerEnter={() => {
        void loadChat();
      }}
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border p-8 text-center">
        <h3 className="text-sm font-medium">Ask about PermDock</h3>
        <p className="text-sm text-muted-foreground">
          Answers come from these docs, with links to the pages they use.
        </p>
      </div>
      <InputGroup>
        <InputGroupTextarea
          aria-label="Question"
          placeholder="How do I guard a Server Action?"
          readOnly
          onFocus={onActivate}
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton
            aria-label="Send"
            size="icon-sm"
            variant="default"
            className="ml-auto"
            disabled
          >
            <ArrowUpIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

const AskAiChat = dynamic(() => loadChat().then((module) => module.AskAiChat), {
  ssr: false,
  loading: () => <AskAiShell />,
});

/** Ask AI. The chat and its Markdown renderer load on first focus, prefetched on pointer enter. */
export function AskAi() {
  const [active, setActive] = useState(false);
  if (active) {
    return <AskAiChat />;
  }
  return (
    <AskAiShell
      onActivate={() => {
        setActive(true);
      }}
    />
  );
}
