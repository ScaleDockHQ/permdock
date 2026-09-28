import type { ChatAddToolApproveResponseFunction, UIMessage } from 'ai';

import { useChat } from '@ai-sdk/react';
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from 'ai';
import { useEffect, useState } from 'react';

type Pending = { readonly token: string; readonly permission: string };

const USERS = ['alice', 'bob', 'carol'] as const;

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function Login() {
  return (
    <main>
      <h1>Sign in</h1>
      {USERS.map((user) => (
        <button
          key={user}
          type="button"
          onClick={() => {
            void post('/api/login', { user }).then(() => {
              window.location.reload();
            });
          }}
        >
          Sign in as {user}
        </button>
      ))}
    </main>
  );
}

function Part(props: {
  readonly part: UIMessage['parts'][number];
  readonly respond: ChatAddToolApproveResponseFunction;
}) {
  const { part, respond } = props;
  if (part.type === 'text') {
    return <p data-testid="text">{part.text}</p>;
  }
  if (!isToolUIPart(part)) {
    return null;
  }
  return (
    <div data-testid={`tool-${getToolName(part)}`} data-state={part.state}>
      {part.state === 'approval-requested' ? (
        <>
          <span data-testid="approval-reason">
            {part.approval.requestReason}
          </span>
          <button
            type="button"
            onClick={() =>
              void respond({ id: part.approval.id, approved: true })
            }
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() =>
              void respond({ id: part.approval.id, approved: false })
            }
          >
            Deny
          </button>
        </>
      ) : null}
      {part.state === 'output-available' ? (
        <pre data-testid="output">{JSON.stringify(part.output)}</pre>
      ) : null}
      {part.state === 'output-denied' ? (
        <span data-testid="denied">{part.approval.reason ?? 'denied'}</span>
      ) : null}
      {part.state === 'output-error' ? (
        <span data-testid="error">{part.errorText}</span>
      ) : null}
    </div>
  );
}

function Chat() {
  const { messages, sendMessage, status, addToolApprovalResponse } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  const [input, setInput] = useState('');
  return (
    <main>
      <p data-testid="status">{status}</p>
      <ol>
        {messages.map((message) => (
          <li key={message.id} data-role={message.role}>
            {message.parts.map((part, index) => (
              <Part
                key={`${message.id}-${String(index)}`}
                part={part}
                respond={addToolApprovalResponse}
              />
            ))}
          </li>
        ))}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sendMessage({ text: input });
          setInput('');
        }}
      >
        <input
          aria-label="Message"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
          }}
        />
        <button type="submit" disabled={status !== 'ready'}>
          Send
        </button>
      </form>
    </main>
  );
}

function Approvals() {
  const [pending, setPending] = useState<readonly Pending[]>([]);
  const [result, setResult] = useState('');
  const load = (): void => {
    fetch('/api/approvals/pending', { credentials: 'include' })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ items: Pending[] }>)
          : { items: [] },
      )
      .then((page) => {
        setPending(page.items);
      })
      .catch(() => undefined);
  };
  useEffect(load, []);
  return (
    <main>
      <h1>Approvals</h1>
      <ul>
        {pending.map((request) => (
          <li key={request.token} data-testid="pending">
            {request.permission}
            <button
              type="button"
              onClick={() => {
                void post(
                  `/api/approvals/${encodeURIComponent(request.token)}/approve`,
                  {},
                ).then((response) => {
                  setResult(
                    response.ok
                      ? 'approved'
                      : `refused ${String(response.status)}`,
                  );
                  load();
                });
              }}
            >
              Approve
            </button>
          </li>
        ))}
      </ul>
      <p data-testid="result">{result}</p>
    </main>
  );
}

export function App() {
  const [user, setUser] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then((response) => response.json() as Promise<{ user: string | null }>)
      .then((body) => {
        setUser(body.user);
      })
      .catch(() => {
        setUser(null);
      });
  }, []);
  if (user === undefined) {
    return <p>Loading</p>;
  }
  if (user === null) {
    return <Login />;
  }
  return (
    <>
      <p data-testid="user">{user}</p>
      {window.location.pathname === '/approvals' ? <Approvals /> : <Chat />}
    </>
  );
}
