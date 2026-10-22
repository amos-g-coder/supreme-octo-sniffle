import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'inflex-fixture', version: '1.0.0' });
server.registerTool(
  'read_echo',
  {
    description: 'Echo a read-only observation',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  ({ text }) => ({ content: [{ type: 'text', text }] }),
);
server.registerTool(
  'unannotated_write',
  { description: 'Unannotated tool requiring approval', inputSchema: {} },
  () => ({ content: [{ type: 'text', text: 'changed' }] }),
);

let count = 0;
server.registerTool('private_counter', { inputSchema: {}, annotations: { readOnlyHint: false } }, () => ({
  content: [{ type: 'text', text: String(++count) }],
}));

await server.connect(new StdioServerTransport());
