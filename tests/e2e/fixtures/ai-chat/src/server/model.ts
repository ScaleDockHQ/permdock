import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

type LanguageModelV4CallOptions = Parameters<
  MockLanguageModelV4['doStream']
>[0];
type LanguageModelV4StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4['doStream']>
  >['stream'] extends ReadableStream<infer T>
    ? T
    : never;

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

type Prompt = LanguageModelV4CallOptions['prompt'];

function textReply(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...text.split(/(?<= )/u).map((delta): LanguageModelV4StreamPart => ({
      type: 'text-delta',
      id: 't',
      delta,
    })),
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: undefined },
      usage,
    },
  ];
}

/** Streams the arguments in pieces before the call, like a real provider. */
function toolCall(
  name: string,
  input: Readonly<Record<string, unknown>>,
): LanguageModelV4StreamPart[] {
  const id = `call-${name}-${String(Date.now())}`;
  const json = JSON.stringify(input);
  const middle = Math.ceil(json.length / 2);
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName: name },
    { type: 'tool-input-delta', id, delta: json.slice(0, middle) },
    { type: 'tool-input-delta', id, delta: json.slice(middle) },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName: name, input: json },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
    },
  ];
}

function describeOutput(output: unknown): string {
  if (output !== null && typeof output === 'object' && 'type' in output) {
    const typed = output as {
      readonly type: string;
      readonly value?: unknown;
      readonly reason?: string;
    };
    if (typed.type === 'execution-denied') {
      return `denied (${typed.reason ?? 'no reason'})`;
    }
    return JSON.stringify(typed.value ?? null);
  }
  return JSON.stringify(output ?? null);
}

function userText(prompt: Prompt): string {
  const last = prompt.at(-1);
  if (last?.role !== 'user') {
    return '';
  }
  return last.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join(' ');
}

/**
 * A deterministic stand-in for a provider: tool results get a summary, and a
 * user message maps to one tool call. `tools` lists what it was offered, so a
 * test can see the capability middleware at work.
 */
function script(
  options: LanguageModelV4CallOptions,
): LanguageModelV4StreamPart[] {
  const last = options.prompt.at(-1);
  if (last?.role === 'tool') {
    const lines = last.content.flatMap((part) =>
      part.type === 'tool-result'
        ? [`${part.toolName}: ${describeOutput(part.output)}`]
        : [],
    );
    return textReply(
      lines.length === 0 ? 'Nothing to report.' : lines.join('; '),
    );
  }
  const text = userText(options.prompt).toLowerCase();
  const remove = /delete (\S+)/u.exec(text);
  if (remove?.[1] !== undefined) {
    return toolCall('delete_project', { id: remove[1] });
  }
  if (text.includes('revoke')) {
    return toolCall('revoke_api_keys', {});
  }
  if (text.includes('list')) {
    return toolCall('list_projects', {});
  }
  if (text.includes('tools')) {
    const offered = (options.tools ?? []).map((tool) => tool.name).toSorted();
    return textReply(
      `Tools: ${offered.length === 0 ? 'none' : offered.join(', ')}`,
    );
  }
  return textReply('Ask me to list, delete or revoke.');
}

export function scriptedModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: (options) =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: script(options),
          chunkDelayInMs: 10,
        }),
      }),
  });
}
