import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { inflexConfiguration } from '../src/config';
import { StdioToolSource } from '../src/inflex/stdio';
import { nativeToolSet } from '../src/inflex/tools';
import { workspacePath } from '../src/inflex/workspace';

const fixture = createServer((_request, response) => {
  response
    .writeHead(200, { 'Content-Type': 'text/html' })
    .end(
      "<!doctype html><title>Inflex browser verification</title><button onclick=\"document.querySelector('output').textContent='Verified browser action'\">Run check</button><output>Ready</output>",
    );
});
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
const address = fixture.address();
if (!address || typeof address === 'string') {
  throw new Error('Cannot bind browser fixture');
}
const workspace = await mkdtemp(path.join(tmpdir(), 'inflex-browser-'));
const source = new StdioToolSource({
  workspace,
  server: {
    name: 'browser-probe',
    enabled: true,
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../../../capabilities/node_modules/@playwright/mcp/cli.js', import.meta.url)),
      '--headless',
      '--isolated',
      ...(inflexConfiguration.browser_executable ? ['--executable-path', inflexConfiguration.browser_executable] : []),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    ],
  },
  signal: new AbortController().signal,
});
const tools = nativeToolSet(source);
const run = async (input: { name: string; arguments: Record<string, unknown> }) => {
  const response = await tools.callTool(input, { status: 'allow' });
  if (!('result' in response) || response.result.isError) {
    throw new Error(JSON.stringify(response));
  }
  const text = response.result.content.flatMap(item => (item.type === 'text' ? [item.text] : [])).join('\n');
  const snapshot = /\[Snapshot\]\(([^)]+)\)/.exec(text)?.[1];
  return snapshot
    ? text +
        (await readFile(
          await workspacePath({ root: workspace, requested: snapshot, write: false, owned_paths: undefined }),
          'utf8',
        ))
    : text;
};
try {
  const snapshot = await run({
    name: 'browser_navigate',
    arguments: { url: `http://127.0.0.1:${String(address.port)}` },
  });
  const reference = /button "Run check" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];
  if (!reference) {
    throw new Error(`Browser did not observe the fixture button: ${snapshot}`);
  }
  const clicked = await run({ name: 'browser_click', arguments: { element: 'Run check button', target: reference } });
  if (!clicked.includes('Verified browser action')) {
    throw new Error('Browser action was not verified');
  }
  const { values } = parseArgs({ options: { gui: { type: 'string' } } });
  if (values.gui) {
    await run({ name: 'browser_navigate', arguments: { url: values.gui } });
    const app = await run({ name: 'browser_snapshot', arguments: {} });
    if (!app.includes('Inflex') || !app.includes('Sign in with ChatGPT')) {
      throw new Error(`Inflex sign-in interface did not render: ${app}`);
    }
  }
  console.log(
    JSON.stringify({
      passed: true,
      engine: 'Playwright MCP',
      navigation: true,
      observed_dom: true,
      clicked: true,
      gui_sign_in: Boolean(values.gui),
    }),
  );
} finally {
  await source.close();
  fixture.close();
  fixture.closeAllConnections();
  await rm(workspace, { recursive: true, force: true });
}
