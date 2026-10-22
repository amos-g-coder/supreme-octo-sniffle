import type {
  CompletionUsage,
  ExtendedChatCompletionChunk,
  ILLM,
  LLMCreateParams,
  LLMCreateParamsStreaming,
  RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core';
import { z } from 'zod';
import type { ChatGPTOAuth } from './oauth';
import { inferenceScheduler } from './scheduler';

const ReasoningSchema = z.object({
  type: z.literal('reasoning'),
  id: z.string(),
  encrypted_content: z.string().nullable().optional(),
  summary: z.array(z.unknown()).default([]),
});
const MessageSchema = z.object({
  type: z.literal('message'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});
const CallSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});
const ResponseSchema = z.object({
  id: z.string(),
  status: z.literal('completed'),
  output: z.array(z.discriminatedUnion('type', [ReasoningSchema, MessageSchema, CallSchema])),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
    output_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional(),
  }),
});
const EventSchema = z.object({ type: z.string(), delta: z.string().optional(), response: z.unknown().optional() });

export async function* responseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<z.infer<typeof EventSchema>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      buffer = (buffer + decoder.decode(part.value, { stream: true })).replaceAll('\r\n', '\n');
      if (buffer.length > 16_000_000) {
        throw new Error('Inference event exceeded limit');
      }
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') {
          yield EventSchema.parse(JSON.parse(data));
        }
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export class ChatGPTLLM implements ILLM {
  private usage: CompletionUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  constructor(
    private readonly options: { auth: ChatGPTOAuth; model: string; fetch: typeof fetch; signal: AbortSignal },
  ) {}
  getUsage(): CompletionUsage {
    return { ...this.usage };
  }
  async *create(
    body: LLMCreateParamsStreaming,
  ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    const release = await inferenceScheduler.acquire({ priority: 10, signal: this.options.signal });
    try {
      const input: unknown[] = [];
      const instructions: string[] = [];
      for (const message of body.messages) {
        if (message.role === 'system' || message.role === 'developer') {
          instructions.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
          continue;
        }
        if (message.role === 'tool') {
          input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
          continue;
        }
        if (message.role === 'assistant') {
          const preserved = z
            .object({
              thinking_blocks: z.array(z.object({ type: z.string(), data: z.string().optional() })).optional(),
            })
            .parse(message);
          for (const block of preserved.thinking_blocks ?? []) {
            if (block.type === 'redacted_thinking' && block.data) {
              input.push(ReasoningSchema.parse(JSON.parse(block.data)));
            }
          }
          if (message.content) {
            input.push({
              role: 'assistant',
              content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
            });
          }
          for (const call of message.tool_calls ?? []) {
            if (call.type === 'function') {
              input.push({
                type: 'function_call',
                call_id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
              });
            }
          }
          continue;
        }
        if (message.role === 'user') {
          input.push({
            role: 'user',
            content:
              typeof message.content === 'string'
                ? message.content
                : message.content.map(part =>
                    part.type === 'text'
                      ? { type: 'input_text', text: part.text }
                      : part.type === 'image_url'
                        ? {
                            type: 'input_image',
                            image_url: part.image_url.url,
                            detail: part.image_url.detail ?? 'auto',
                          }
                        : { type: 'input_text', text: '[Unsupported input; use the audio or document tools]' },
                  ),
          });
        }
      }
      const tools = (body.tools ?? []).flatMap(tool =>
        tool.type === 'function'
          ? [
              {
                type: 'function',
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
                strict: false,
              },
            ]
          : [],
      );
      const response = await this.options.fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.options.auth.accessToken()}`,
          'Content-Type': 'application/json',
        },
        signal: this.options.signal,
        body: JSON.stringify({
          model: this.options.model,
          instructions: instructions.join('\n\n'),
          input,
          tools,
          store: false,
          stream: true,
          include: ['reasoning.encrypted_content'],
          ...(body.reasoning_effort ? { reasoning: { effort: body.reasoning_effort } } : {}),
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `ChatGPT inference failed (${String(response.status)}); verify sign-in, model access, and plan limits`,
        );
      }
      let completed: z.infer<typeof ResponseSchema> | undefined;
      for await (const event of responseEvents(response.body)) {
        if (event.type === 'response.output_text.delta' && event.delta) {
          yield {
            id: 'inflex-stream',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.options.model,
            choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }],
          };
        }
        if (event.type === 'response.completed') {
          completed = ResponseSchema.parse(event.response);
        }
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) {
          throw new Error(`Inference ended with ${event.type}`);
        }
      }
      if (!completed) {
        throw new Error('Inference stream ended before completion; no tool effects were accepted');
      }
      const usage = completed.usage;
      this.usage = {
        input_tokens: this.usage.input_tokens + usage.input_tokens,
        output_tokens: this.usage.output_tokens + usage.output_tokens,
        total_tokens: this.usage.total_tokens + usage.total_tokens,
      };
      const calls = completed.output
        .filter(item => item.type === 'function_call')
        .map(call => ({
          id: call.call_id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        }));
      return {
        output: {
          role: 'assistant',
          content: completed.output
            .filter(item => item.type === 'message')
            .flatMap(item => item.content.map(part => part.text ?? ''))
            .join(''),
          ...(calls.length ? { tool_calls: calls } : {}),
          thinking_blocks: completed.output
            .filter(item => item.type === 'reasoning')
            .map(item => ({ type: 'redacted_thinking', data: JSON.stringify(item) })),
        },
        usage,
        finish_reason: calls.length ? 'tool_calls' : 'stop',
      };
    } finally {
      release();
    }
  }
  async createNonStream(body: LLMCreateParams): Promise<RawAssistantMessageWithUsage> {
    const stream = this.create({ ...body, stream: true });
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        return next.value;
      }
    }
  }
}
