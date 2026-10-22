import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResponse,
  InternalToolCallInfo,
  ListToolsResolvedResponse,
  ToolSource,
} from '@truefoundry/trueforge-core/core';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { inflexConfiguration } from '../config';

const ConnectionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  enabled: z.boolean().default(false),
  delegation: z.enum(['parent', 'agent']).optional(),
});
const ConnectionsSchema = z.object({ servers: z.array(ConnectionSchema) });
export type StdioConnection = z.infer<typeof ConnectionSchema>;
export async function localConnections(): Promise<StdioConnection[]> {
  try {
    return ConnectionsSchema.parse(
      JSON.parse(await readFile(inflexConfiguration.connections_file, 'utf8')),
    ).servers.filter(server => server.enabled);
  } catch (error) {
    if (z.object({ code: z.literal('ENOENT') }).safeParse(error).success) {
      return [];
    }
    throw error;
  }
}
export class StdioToolSource implements ToolSource {
  readonly name: string;
  readonly id: string;
  private readonly client = new Client({ name: 'Inflex', version: '0.1.0' });
  private connection: Promise<void> | undefined;
  constructor(private readonly options: { server: StdioConnection; workspace: string; signal: AbortSignal }) {
    this.name = options.server.name;
    this.id = `inflex-stdio-${this.name}`;
    options.signal.addEventListener(
      'abort',
      () => {
        void this.client.close().catch(() => {
          /* Cleanup or queue recovery must preserve the original operation result. */
        });
      },
      { once: true },
    );
  }
  private async connect(): Promise<void> {
    this.options.signal.throwIfAborted();
    if (!this.connection) {
      const transport = new StdioClientTransport({
        command: this.options.server.command,
        args: this.options.server.args,
        cwd: this.options.workspace,
        env: inflexConfiguration.execution_env,
        stderr: 'pipe',
      });
      this.connection = this.client.connect(transport);
      transport.stderr?.on('data', () => {
        /* Drain helper diagnostics without mixing them into MCP messages. */
      });
    }
    await this.connection;
  }
  async close(): Promise<void> {
    await this.client.close();
  }
  async listTools(): Promise<ListToolsResolvedResponse> {
    await this.connect();
    const tools = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.client.listTools(cursor ? { cursor } : {});
      tools.push(...result.tools.map(tool => ({ ...tool, preload: true })));
      cursor = result.nextCursor;
      if (cursor && seen.has(cursor)) {
        throw new Error('MCP server repeated a pagination cursor');
      }
      if (cursor) {
        seen.add(cursor);
      }
      if (tools.length > 2000) {
        throw new Error('MCP server tool catalog exceeded limit');
      }
    } while (cursor);
    return { result: { tools }, wasInitialized: undefined };
  }
  async callTool(params: CallToolRequest['params']): Promise<CallToolResponse> {
    await this.connect();
    const result = await this.client.callTool(params, undefined, { signal: this.options.signal, timeout: 120_000 });
    return { result: CallToolResultSchema.parse(result), wasInitialized: undefined };
  }
  toolCallInfo(params: CallToolRequest['params']): Promise<InternalToolCallInfo> {
    return Promise.resolve({
      type: 'mcp',
      mcp_server_id: this.id,
      mcp_server_name: this.name,
      original_tool_name: params.name,
    });
  }
}
