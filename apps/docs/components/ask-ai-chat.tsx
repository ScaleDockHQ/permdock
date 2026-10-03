'use client';

import type { KeyboardEvent, SubmitEvent } from 'react';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { ArrowUpIcon, SquareIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { chatRoute } from '@/lib/shared';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@permdock/ui/components/ai-elements/conversation';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@permdock/ui/components/ai-elements/message';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@permdock/ui/components/input-group';

export function AskAiChat() {
  const [input, setInput] = useState('');
  const [transport] = useState(
    () => new DefaultChatTransport({ api: chatRoute }),
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    textarea.current?.focus();
  }, []);
  const { messages, sendMessage, status, stop, error } = useChat({
    id: 'docs-ask-ai',
    transport,
  });
  const busy = status === 'submitted' || status === 'streaming';

  function submit(event?: SubmitEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = input.trim();
    if (text === '' || busy) {
      return;
    }
    void sendMessage({ text });
    setInput('');
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex h-[70vh] flex-col gap-4">
      <Conversation className="rounded-lg border">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="Ask about PermDock"
              description="Answers come from these docs, with links to the pages they use."
            />
          ) : null}
          {messages.map((message) => (
            <Message from={message.role} key={message.id}>
              <MessageContent>
                {message.parts.map((part, index) =>
                  part.type === 'text' ? (
                    <MessageResponse key={`${message.id}-${String(index)}`}>
                      {part.text}
                    </MessageResponse>
                  ) : null,
                )}
              </MessageContent>
            </Message>
          ))}
          {status === 'submitted' ? (
            <p className="text-muted-foreground text-sm">Searching the docs…</p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive">
              The assistant is unavailable right now. Try again, or use search.
            </p>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <form onSubmit={submit}>
        <InputGroup>
          <InputGroupTextarea
            ref={textarea}
            aria-label="Question"
            placeholder="How do I guard a Server Action?"
            value={input}
            onChange={(event) => {
              setInput(event.currentTarget.value);
            }}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon align="block-end">
            {busy ? (
              <InputGroupButton
                aria-label="Stop"
                size="icon-sm"
                variant="default"
                className="ml-auto"
                onClick={() => {
                  void stop();
                }}
              >
                <SquareIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                aria-label="Send"
                type="submit"
                size="icon-sm"
                variant="default"
                className="ml-auto"
                disabled={input.trim() === ''}
              >
                <ArrowUpIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}
