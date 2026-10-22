import path from 'node:path';
import { closeInflexConnections, sessionConnections } from '../../../src/inflex/mcp-pool';
import { StdioToolSource } from '../../../src/inflex/stdio';
import { nativeToolSet } from '../../../src/inflex/tools';

it('uses a real MCP stdio subprocess through the same approval contract and closes it', async () => {
  const controller = new AbortController();
  const source = new StdioToolSource({
    workspace: __dirname,
    server: {
      name: 'fixture',
      command: process.execPath,
      args: [path.join(__dirname, 'fixtures/mcp.mjs')],
      enabled: true,
    },
    signal: controller.signal,
  });
  try {
    const tools = nativeToolSet(source);
    expect(await tools.listTools()).toHaveProperty(
      'result.tools',
      expect.arrayContaining([expect.objectContaining({ name: 'read_echo' })]),
    );
    expect(await tools.callTool({ name: 'read_echo', arguments: { text: 'verified observation' } })).toHaveProperty(
      'result.content',
      [{ type: 'text', text: 'verified observation' }],
    );
    expect(await tools.callTool({ name: 'unannotated_write', arguments: {} })).toHaveProperty('approvalRequired');
    expect(await tools.callTool({ name: 'unannotated_write', arguments: {} }, { status: 'allow' })).toHaveProperty(
      'result.content',
      [{ type: 'text', text: 'changed' }],
    );
  } finally {
    await source.close();
    controller.abort();
  }
});

it('reuses an MCP session across turns and closes sources on cancellation', async () => {
  const first = new AbortController();
  const second = new AbortController();
  const server = {
    name: 'pooled-fixture',
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures/mcp.mjs')],
    enabled: true,
  };
  try {
    const a = sessionConnections({ session_id: 'fixture-session', workspace: __dirname, signal: first.signal });
    const source = a.pool.source(server);
    await source.listTools();
    a.release();
    a.release();
    const b = sessionConnections({ session_id: 'fixture-session', workspace: __dirname, signal: second.signal });
    expect(b.pool.source(server)).toBe(source);
    second.abort();
    await expect(source.listTools()).rejects.toThrow();
    b.release();
    const c = sessionConnections({ session_id: 'fixture-session', workspace: __dirname, signal: first.signal });
    expect(c.pool.source(server)).not.toBe(source);
    c.release();
  } finally {
    await closeInflexConnections();
  }
});

it('gives delegated agents independent stateful MCP processes', async () => {
  const signal = new AbortController().signal;
  const server = {
    name: 'isolated-fixture',
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures/mcp.mjs')],
    enabled: true,
  };
  const a = sessionConnections({ session_id: 'session:main', workspace: __dirname, signal });
  const b = sessionConnections({ session_id: 'session:child', workspace: __dirname, signal });
  try {
    const first = nativeToolSet(a.pool.source(server));
    const second = nativeToolSet(b.pool.source(server));
    const call = { name: 'private_counter', arguments: {} };
    expect(await first.callTool(call, { status: 'allow' })).toHaveProperty('result.content.0.text', '1');
    expect(await first.callTool(call, { status: 'allow' })).toHaveProperty('result.content.0.text', '2');
    expect(await second.callTool(call, { status: 'allow' })).toHaveProperty('result.content.0.text', '1');
  } finally {
    a.release();
    b.release();
    await closeInflexConnections();
  }
});
